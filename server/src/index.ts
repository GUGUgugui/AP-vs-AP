import 'dotenv/config'
import express from 'express'
import { createServer } from 'http'
import { Server } from 'socket.io'
import pino from 'pino'
import { setupSocketHandlers } from './socket'
import { GameManager } from './game'
import { DeepSeekClient } from './deepseek'

const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY
const PORT = Number.parseInt(process.env.PORT || '3001', 10)

if (!DEEPSEEK_API_KEY) {
  console.error('DEEPSEEK_API_KEY 环境变量未设置')
  process.exit(1)
}

const logger = pino({
  name: 'apvsap',
  level: process.env.LOG_LEVEL || 'info',
  transport: process.env.NODE_ENV !== 'production' ? { target: 'pino-pretty' } : undefined,
})

const app = express()
const httpServer = createServer(app)
const io = new Server(httpServer, {
  cors: {
    origin: process.env.CORS_ORIGIN || 'http://localhost:5173',
    methods: ['GET', 'POST'],
  },
})

if (process.env.NODE_ENV === 'production') {
  app.use(express.static('../client/dist'))
}

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), mode: 'mist-match' })
})

const games = new GameManager(logger)
const dialogue = new DeepSeekClient({
  apiKey: DEEPSEEK_API_KEY,
  model: process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash',
}, logger)

setupSocketHandlers(io, games, dialogue, logger)

httpServer.listen(PORT, () => {
  logger.info({ port: PORT }, '人机迷雾服务器已启动')
})

const shutdown = (signal: string) => {
  logger.info({ signal }, '服务器关闭中')
  io.close()
  httpServer.close(() => process.exit(0))
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
