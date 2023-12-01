import crypto from 'crypto'
import http from 'http'
import { hrtime } from 'process'
import { promisify } from 'util'

import express from 'express'
import pino from 'pino'
import pinoHttp from 'pino-http'
import { collectDefaultMetrics, register, Summary } from 'prom-client'

const app = express()

//
// Utilties
//

// Wrap an async function so we can use it with express.
function expressify(fn) {
  return (req, res, next) => {
    fn(req, res, next).catch(next)
  }
}

//
// Logging
//
let pinoOptions
if (process.env.NODE_ENV === 'production')
  pinoOptions = {
    transport: {
      target: 'pino-google-cloud-format-transport',
    },
  }
const logger = pino(pinoOptions)
app.use(
  pinoHttp({
    logger,
    quietReqLogger: true,
  })
)

//
// Health Checks
//
app.get('/livez', (req, res) => {
  res.sendStatus(200)
})

app.get(
  '/readyz',
  expressify(async (req, res) => {
    try {
      await compile('test doc'.repeat(80))
      res.sendStatus(200)
    } catch (err) {
      res.sendStatus(500)
    }
  })
)

//
// Prometheus Metrics
//

collectDefaultMetrics()
const compileTimeMetric = new Summary({
  name: 'compile_time',
  help: 'end to end compile time',
})
app.get(
  '/metrics',
  expressify(async (req, res) => {
    res.set('Content-Type', register.contentType)
    const metrics = await register.metrics()
    res.end(metrics)
  })
)

//
// Server Setup
//
const server = http.createServer(app)
const port = parseInt(process.env.PORT || 8081, 10)
server.listen(port, () => logger.info({ port }, 'up'))
process.on('SIGTERM', () => server.close())

app.use(express.json())

//
// Application Code
//

app.post(
  '/compile',
  expressify(async (req, res) => {
    let { doc, compiler } = req.body
    compiler ||= 'pdftex'

    req.log.info({ compiler, docSize: doc.length }, 'compile starting')

    const stopTimer = compileTimeMetric.startTimer()
    const output = await compile(doc)
    stopTimer()
    res.json({ output })
  })
)

// simulate the work of a compile
const pbkdf2 = promisify(crypto.pbkdf2)
async function compile(doc) {
  const iterations = parseFloat(process.env.COMPILE_ITERATIONS || 10000)
  const workMs = findWorkMs(doc.length)
  const endNs = hrtime.bigint() + BigInt(workMs * 1e6)
  let key = Buffer.from(doc.slice(0, 16))
  do {
    key = await pbkdf2(key, 'salt', iterations, 16, 'md5')
  } while (hrtime.bigint() < endNs)
  return key.toString('hex')
}

// Decide how long the simulated compile should take, based on the
// length of the doc and a randomized work rate (ms/char).
// See https://en.wikipedia.org/wiki/Log-normal_distribution
function findWorkMs(docLength) {
  // ms per character of doc input
  const m = parseFloat(process.env.COMPILE_WORK_RATE || 5)
  const s = parseFloat(process.env.COMPILE_WORK_SD || 1.2)

  const mu = Math.log(m*m / Math.sqrt(m*m + s*s))
  const sigma = Math.log(1 + s*s / m*m)
  const r = mu + randomNormal() * sigma
  return Math.round(Math.exp(r) * docLength)
}

// Result is roughly normal on [-1, 1]. Not very efficient.
function randomNormal(n = 50) {
  let x = 0
  for (let i = 0; i < n; ++i) x += Math.random()
  return (x / n) * 2 - 1
}