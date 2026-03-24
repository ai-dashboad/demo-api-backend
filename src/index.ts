import express from 'express'

const app = express()
const PORT = process.env.PORT ?? 3000

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'demo-api-backend' })
})

app.get('/api/v1/users', (_req, res) => {
  res.json({ data: [{ id: '1', name: 'Alice' }, { id: '2', name: 'Bob' }] })
})

app.listen(PORT, () => {
  console.log(`API running on port ${PORT}`)
})
