import process from 'process'
import fs from 'fs-extra'
import path from 'path'
import { fileURLToPath } from 'url'
import fetch from 'node-fetch'
import slack from '@slack/client'
const { WebClient } = slack

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CACHE_DIR = path.join(__dirname, '/.cache')

const slackToken = process.env.SLACK_ACCESS_TOKEN
if (!slackToken) {
  console.error('Must define SLACK_ACCESS_TOKEN env var')
  process.exit(1)
}

async function getAllEmoji(client) {
  const result = await client.emoji.list()
  const { emoji } = result
  return emoji
}

async function downloadEmoji(name, uri) {
  const ext = path.extname(uri)
  const filename = `${path.join(CACHE_DIR, name)}${ext}`
  const exists = await fs.exists(filename)
  if (exists) return
  console.log(`Downloading ${name}`)
  const stream = fs.createWriteStream(filename)
  const resp = await fetch(uri)
  resp.body.pipe(stream)
}

async function downloadAllEmoji(emojis) {
  await fs.ensureDir(CACHE_DIR)

  for (let [name, uri] of Object.entries(emojis)) {
    const isAlias = uri.startsWith('alias:')
    if (isAlias) continue
    await downloadEmoji(name, uri)
  }
}

async function main() {
  const client = new WebClient(slackToken)
  const emojis = await getAllEmoji(client)
  await downloadAllEmoji(emojis)
}

main()
