const path = require('path')
const uuid = require('uuid/v4')

/* global WIKI */

module.exports = () => {
  WIKI.config.site = {
    path: '',
    title: 'Wiki.js'
  }

  WIKI.system = require('./core/system')

  // ----------------------------------------
  // Load modules
  // ----------------------------------------

  const bodyParser = require('body-parser')
  const compression = require('compression')
  const express = require('express')
  const favicon = require('serve-favicon')
  const http = require('http')
  const Promise = require('bluebird')
  const fs = require('fs-extra')
  const _ = require('lodash')
  const cfgHelper = require('./helpers/config')
  const crypto = Promise.promisifyAll(require('crypto'))
  const pem2jwk = require('pem-jwk').pem2jwk
  const semver = require('semver')

  // ----------------------------------------
  // Define Express App
  // ----------------------------------------

  let app = express()
  app.use(compression())

  // ----------------------------------------
  // Public Assets
  // ----------------------------------------

  app.use(favicon(path.join(WIKI.ROOTPATH, 'assets', 'favicon.ico')))
  app.use(express.static(path.join(WIKI.ROOTPATH, 'assets')))

  // ----------------------------------------
  // View Engine Setup
  // ----------------------------------------

  app.set('views', path.join(WIKI.SERVERPATH, 'views'))
  app.set('view engine', 'pug')

  app.use(bodyParser.json())
  app.use(bodyParser.urlencoded({ extended: false }))

  app.locals.config = WIKI.config
  app.locals.data = WIKI.data
  app.locals._ = require('lodash')

  // ----------------------------------------
  // HMR (Dev Mode Only)
  // ----------------------------------------

  if (global.DEV) {
    app.use(global.WP_DEV.devMiddleware)
    app.use(global.WP_DEV.hotMiddleware)
  }

  // ----------------------------------------
  // Controllers
  // ----------------------------------------

  app.get('*', async (req, res) => {
    let packageObj = await fs.readJson(path.join(WIKI.ROOTPATH, 'package.json'))
    res.render('setup', {
      packageObj,
      telemetryClientID: WIKI.telemetry.cid
    })
  })

  /**
   * Finalize
   */
  app.post('/finalize', async (req, res) => {
    WIKI.telemetry.sendEvent('setup', 'finalize')

    try {
      // Basic checks
      if (!semver.satisfies(process.version, '>=10.14')) {
        throw new Error('Node.js 10.14.x or later required!')
      }

      // Upgrade from WIKI.js 1.x?
      if (req.body.upgrade) {
        await WIKI.system.upgradeFromMongo({
          mongoCnStr: cfgHelper.parseConfigValue(req.body.upgMongo)
        })
      }

      // Create directory structure
      WIKI.logger.info('Creating data directories...')
      const dataPath = path.join(process.cwd(), 'data')
      await fs.ensureDir(dataPath)
      await fs.emptyDir(path.join(dataPath, 'cache'))
      await fs.ensureDir(path.join(dataPath, 'uploads'))

      // Set config
      _.set(WIKI.config, 'auth', {
        audience: 'urn:wiki.js',
        tokenExpiration: '30m',
        tokenRenewal: '14d'
      })
      _.set(WIKI.config, 'company', '')
      _.set(WIKI.config, 'features', {
        featurePageRatings: true,
        featurePageComments: true,
        featurePersonalWikis: true
      })
      _.set(WIKI.config, 'graphEndpoint', 'https://graph.requarks.io')
      _.set(WIKI.config, 'host', 'http://')
      _.set(WIKI.config, 'lang', {
        code: 'en',
        autoUpdate: true,
        namespacing: false,
        namespaces: []
      })
      _.set(WIKI.config, 'logo', {
        hasLogo: false,
        logoIsSquare: false
      })
      _.set(WIKI.config, 'mail', {
        senderName: '',
        senderEmail: '',
        host: '',
        port: 465,
        secure: true,
        user: '',
        pass: '',
        useDKIM: false,
        dkimDomainName: '',
        dkimKeySelector: '',
        dkimPrivateKey: ''
      })
      _.set(WIKI.config, 'seo', {
        description: '',
        robots: ['index', 'follow'],
        analyticsService: '',
        analyticsId: ''
      })
      _.set(WIKI.config, 'sessionSecret', (await crypto.randomBytesAsync(32)).toString('hex'))
      _.set(WIKI.config, 'telemetry', {
        isEnabled: req.body.telemetry === true,
        clientId: WIKI.telemetry.cid
      })
      _.set(WIKI.config, 'theming', {
        theme: 'default',
        darkMode: false
      })
      _.set(WIKI.config, 'title', 'Wiki.js')

      // Generate certificates
      WIKI.logger.info('Generating certificates...')
      const certs = crypto.generateKeyPairSync('rsa', {
        modulusLength: 2048,
        publicKeyEncoding: {
          type: 'pkcs1',
          format: 'pem'
        },
        privateKeyEncoding: {
          type: 'pkcs1',
          format: 'pem',
          cipher: 'aes-256-cbc',
          passphrase: WIKI.config.sessionSecret
        }
      })

      _.set(WIKI.config, 'certs', {
        jwk: pem2jwk(certs.publicKey),
        public: certs.publicKey,
        private: certs.privateKey
      })

      // Save config to DB
      WIKI.logger.info('Persisting config to DB...')
      await WIKI.configSvc.saveToDb([
        'auth',
        'certs',
        'company',
        'features',
        'graphEndpoint',
        'host',
        'lang',
        'logo',
        'mail',
        'seo',
        'sessionSecret',
        'telemetry',
        'theming',
        'title'
      ])

      // Create default locale
      WIKI.logger.info('Installing default locale...')
      await WIKI.models.locales.query().insert({
        code: 'en',
        strings: {},
        isRTL: false,
        name: 'English',
        nativeName: 'English'
      })

      // Create default groups

      WIKI.logger.info('Creating default groups...')
      const adminGroup = await WIKI.models.groups.query().insert({
        name: 'Administrators',
        permissions: JSON.stringify(['manage:system']),
        pageRules: JSON.stringify([]),
        isSystem: true
      })
      const guestGroup = await WIKI.models.groups.query().insert({
        name: 'Guests',
        permissions: JSON.stringify(['read:pages', 'read:assets', 'read:comments']),
        pageRules: JSON.stringify([
          { id: 'guest', roles: ['read:pages', 'read:assets', 'read:comments'], match: 'START', deny: false, path: '', locales: [] }
        ]),
        isSystem: true
      })

      // Load authentication strategies + enable local
      await WIKI.models.authentication.refreshStrategiesFromDisk()
      await WIKI.models.authentication.query().patch({ isEnabled: true }).where('key', 'local')

      // Load editors + enable default
      await WIKI.models.editors.refreshEditorsFromDisk()
      await WIKI.models.editors.query().patch({ isEnabled: true }).where('key', 'markdown')

      // Load loggers
      await WIKI.models.loggers.refreshLoggersFromDisk()

      // Load renderers
      await WIKI.models.renderers.refreshRenderersFromDisk()

      // Load search engines + enable default
      await WIKI.models.searchEngines.refreshSearchEnginesFromDisk()
      await WIKI.models.searchEngines.query().patch({ isEnabled: true }).where('key', 'db')

      // Load storage targets
      await WIKI.models.storage.refreshTargetsFromDisk()

      // Create root administrator
      WIKI.logger.info('Creating root administrator...')
      await WIKI.models.users.query().delete().where({
        providerKey: 'local',
        email: req.body.adminEmail
      })
      const adminUser = await WIKI.models.users.query().insert({
        email: req.body.adminEmail,
        provider: 'local',
        password: req.body.adminPassword,
        name: 'Administrator',
        locale: 'en',
        defaultEditor: 'markdown',
        tfaIsActive: false,
        isActive: true,
        isVerified: true
      })
      await adminUser.$relatedQuery('groups').relate(adminGroup.id)

      // Create Guest account
      WIKI.logger.info('Creating guest account...')
      await WIKI.models.users.query().delete().where({
        providerKey: 'local',
        email: 'guest@example.com'
      })
      const guestUser = await WIKI.models.users.query().insert({
        provider: 'local',
        email: 'guest@example.com',
        name: 'Guest',
        password: '',
        locale: 'en',
        defaultEditor: 'markdown',
        tfaIsActive: false,
        isSystem: true,
        isActive: true,
        isVerified: true
      })
      await guestUser.$relatedQuery('groups').relate(guestGroup.id)

      // Create site nav

      WIKI.logger.info('Creating default site navigation')
      await WIKI.models.navigation.query().delete().where({ key: 'site' })
      await WIKI.models.navigation.query().insert({
        key: 'site',
        config: [
          {
            id: uuid(),
            icon: 'home',
            kind: 'link',
            label: 'Home',
            target: '/',
            targetType: 'home'
          }
        ]
      })

      WIKI.logger.info('Setup is complete!')
      res.json({
        ok: true,
        redirectPath: '/',
        redirectPort: WIKI.config.port
      }).end()

      WIKI.config.setup = false

      WIKI.logger.info('Stopping Setup...')
      WIKI.server.destroy(() => {
        WIKI.logger.info('Setup stopped. Starting Wiki.js...')
        _.delay(() => {
          WIKI.kernel.bootMaster()
        }, 1000)
      })
    } catch (err) {
      res.json({ ok: false, error: err.message })
    }
  })

  // ----------------------------------------
  // Error handling
  // ----------------------------------------

  app.use(function (req, res, next) {
    var err = new Error('Not Found')
    err.status = 404
    next(err)
  })

  app.use(function (err, req, res, next) {
    res.status(err.status || 500)
    res.send({
      message: err.message,
      error: WIKI.IS_DEBUG ? err : {}
    })
    WIKI.logger.error(err.message)
    WIKI.telemetry.sendError(err)
  })

  // ----------------------------------------
  // Start HTTP server
  // ----------------------------------------

  WIKI.logger.info(`HTTP Server on port: [ ${WIKI.config.port} ]`)

  app.set('port', WIKI.config.port)
  WIKI.server = http.createServer(app)
  WIKI.server.listen(WIKI.config.port, WIKI.config.bindIP)

  var openConnections = []

  WIKI.server.on('connection', (conn) => {
    let key = conn.remoteAddress + ':' + conn.remotePort
    openConnections[key] = conn
    conn.on('close', () => {
      delete openConnections[key]
    })
  })

  WIKI.server.destroy = (cb) => {
    WIKI.server.close(cb)
    for (let key in openConnections) {
      openConnections[key].destroy()
    }
  }

  WIKI.server.on('error', (error) => {
    if (error.syscall !== 'listen') {
      throw error
    }

    switch (error.code) {
      case 'EACCES':
        WIKI.logger.error('Listening on port ' + WIKI.config.port + ' requires elevated privileges!')
        return process.exit(1)
      case 'EADDRINUSE':
        WIKI.logger.error('Port ' + WIKI.config.port + ' is already in use!')
        return process.exit(1)
      default:
        throw error
    }
  })

  WIKI.server.on('listening', () => {
    WIKI.logger.info('HTTP Server: [ RUNNING ]')
    WIKI.logger.info('🔻🔻🔻🔻🔻🔻🔻🔻🔻🔻🔻🔻🔻🔻🔻🔻🔻🔻🔻🔻🔻🔻🔻🔻🔻🔻🔻🔻🔻')
    WIKI.logger.info('')
    WIKI.logger.info(`Browse to http://localhost:${WIKI.config.port}/ to complete setup!`)
    WIKI.logger.info('')
    WIKI.logger.info('🔺🔺🔺🔺🔺🔺🔺🔺🔺🔺🔺🔺🔺🔺🔺🔺🔺🔺🔺🔺🔺🔺🔺🔺🔺🔺🔺🔺🔺')
  })
}
