import crypto from 'crypto'
import http from 'http'

import express from 'express'
import pino from 'pino'
import pinoHttp from 'pino-http'
import { collectDefaultMetrics, register } from 'prom-client'

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

const CLSI_HOST = process.env.CLSI_SERVICE_HOST || 'localhost'
const CLSI_PORT = parseInt(process.env.CLSI_SERVICE_PORT || 8081, 10)

app.get(
  '/readyz',
  expressify(async (req, res) => {
    try {
      const url = new URL(`http://${CLSI_HOST}:${CLSI_PORT}/readyz`)
      const response = await fetch(url, {
        signal: AbortSignal.timeout(5000),
      })
      if (response.ok) {
        res.sendStatus(200)
      } else {
        res.sendStatus(503)
      }
    } catch (err) {
      res.sendStatus(500)
    }
  })
)

//
// Prometheus Metrics
//

collectDefaultMetrics()
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
const port = parseInt(process.env.PORT || 8080, 10)
server.listen(port, () => {
  logger.info({ port }, 'up')
})
process.on('SIGTERM', () => {
  server.close()
})

//
// Application Code
//

app.use(express.json())

app.get('/', (req, res) => {
  res.send(`
<html>
  <head>
    <title>Compiler Demo</title>
    <script>
      let inFlight = 0
      async function compile() {
        ++inFlight
        const url = new URL('/compile', window.location.origin)
        try {
          const response = await fetchJson(url, {
            method: 'POST',
            signal: AbortSignal.timeout(20000)
          })
          if (response.ok) {
            const body = await response.json()
            logResult('Success! ' + JSON.stringify(body))
          } else {
            logResult('request failed with status ' + response.status)
          }
        } catch (err) {
          if (err.name === 'AbortError') {
            logResult('request was aborted (probably took >20s and timed out)')
          } else {
            logResult(err.name + ': ' + err.message)
          }
        } finally {
          --inFlight
        }
      }

      let demandTestMs = 5000
      let demandTestInterval = null
      function toggleDemandTest() {
        if (demandTestInterval) {
          clearTimeout(demandTestInterval)
          demandTestInterval = null
          document.querySelector('#demand-test').textContent = 'Generate Compiles'
          return
        }
        compile().catch(alert)
        demandTestInterval = setInterval(
          () => compile().catch(alert),
          demandTestMs
        )
        document.querySelector('#demand-test').textContent = 'Stop Generating Compiles'
      }

      function logResult(result) {
        const resultElement = document.createElement('p')
        if (inFlight > 0) result += ' (' + inFlight + ' requests were in flight)'
        resultElement.textContent = result
        document.querySelector('#output').append(resultElement)
      }

      async function fetchJson(url, options = {}) {
        options.headers = {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          ...options.headers,
        }
        const response = await fetch(url, options)
        return response
      }
    </script>
  </head>
  <body>
    <h1>Compiler Demo</h1>
    <p><button onclick="compile().catch(alert)">Run a Simulated Compile</button></p>
    <p><button id="demand-test" onclick="toggleDemandTest()">Generate Compiles</button> (1 compile every 5s)</p>
    <h2>Output</h2>
    <pre id="output"></pre>
  </body>
</html>
`)
})

const DOC_LENGTH = parseInt(process.env.DOC_LENGTH || 1000, 10)

app.post(
  '/compile',
  expressify(async (req, res) => {
    const docLength = 1 + DOC_LENGTH * Math.random()
    const result = await requestCompile(docLength)
    res.send(result)
  })
)

async function requestCompile(docLength) {
  const compileId = crypto.randomUUID().slice(0, 8)
  docLength = Math.floor(docLength)
  logger.info({ compileId, docLength }, 'starting compile request')
  const body = {
    doc: compileId + 'x'.repeat(docLength),
    compiler: 'pdftex',
  }
  const url = new URL(`http://${CLSI_HOST}:${CLSI_PORT}/compile`)
  const response = await fetchJson(url, {
    method: 'POST',
    body: JSON.stringify(body),
  })
  if (response.ok) {
    const result = await response.json()
    logger.info({ compileId, ...result }, 'compile succeeded')
    return result
  } else {
    throw new Error(`compile failed: status ${response.status}`)
  }
}

async function fetchJson(url, options = {}) {
  options.headers = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    ...options.headers,
  }
  const response = await fetch(url, options)
  return response
}
