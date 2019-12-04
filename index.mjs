import process from 'process'
import { exec } from 'child_process'
import fs from 'fs-extra'
import path from 'path'
import { fileURLToPath } from 'url'
import fetch from 'node-fetch'
import slack from '@slack/client'
import ProgressBar from 'progress'
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
  const emojis = Object.entries(emoji).map(([name, uri]) => {
    const isAlias = uri.startsWith('alias:')
    if (isAlias) {
      return { uri, name, alias: true }
    } else {
      const ext = path.extname(uri)
      const filename = `${name}${ext}`
      const filepath = path.join(CACHE_DIR, filename)
      return { name, uri, filename, filepath }
    }
  })
  return emojis
}

async function downloadEmoji(emoji) {
  const stream = fs.createWriteStream(emoji.filepath)
  const resp = await fetch(emoji.uri)
  resp.body.pipe(stream)
  await new Promise((resolve, reject) => {
    stream.once('finish', resolve)
    stream.once('error', reject)
  })
}

async function downloadAllEmoji(emojis) {
  await fs.ensureDir(CACHE_DIR)

  const numEmoji = emojis.length
  const bar = new ProgressBar('downloading emoji [:bar] :current/:total :percent :etas', {
    total: numEmoji,
    width: 80
  })

  for (let i = 0; i < numEmoji; i++) {
    const emoji = emojis[i]

    if (emoji.alias) {
      bar.tick()
      continue
    }

    const exists = await fs.exists(emoji.filepath)
    if (exists) {
      bar.tick()
      continue
    }

    await downloadEmoji(emoji)
    bar.tick()
  }
}

const COLOR_FREQUENCY_REGEX = /(\d+):.+?(#[0-9a-fA-F]{8})/gi
const NUM_PIXELS_REGEX = /Number pixels: (\d+)/i
async function getColorData(filepath) {
  const data = {}

  const output = await new Promise((resolve, reject) => {
    const cmd = `identify -verbose ${filepath.replace(/'/g, "\\'")}`
    exec(cmd, (err, stdout) => {
      if (err) {
        reject(err)
        return
      }
      resolve(stdout)
    })
  })

  {
    const matches = [...output.matchAll(COLOR_FREQUENCY_REGEX)]
    const freqMap = matches.reduce((obj, match) => {
      const amount = parseInt(match[1], 10)
      const color = match[2]
      obj[color] = amount
      return obj
    }, {})
    data.histogram = freqMap
  }

  data.numPixels = parseInt(output.match(NUM_PIXELS_REGEX)[1], 10)

  return data
}

const COLOR_NONE = '#00000000'
const COLOR_BLACK = '#000000FF'

async function determineVerboticon(emoji) {
  if (emoji.name.includes('verboticon')) return true

  // skip gifs
  if (path.extname(emoji.uri) === '.gif') return false

  const { histogram, numPixels } = await getColorData(emoji.filepath)
  const numTransparentPixels = histogram[COLOR_NONE] || 0
  const numBlackPixels = histogram[COLOR_BLACK] || 0
  const percentPrimary = (numTransparentPixels + numBlackPixels) / numPixels
  const isLikelyVerboticon = numTransparentPixels > numBlackPixels && numBlackPixels > 0 && percentPrimary > 0.9

  // if (isLikelyVerboticon) console.debug(`PROB VERBOTICON = ${emoji.name}`)

  return isLikelyVerboticon
}

async function findAllVerboticons(emojis) {
  const numEmoji = emojis.length
  const bar = new ProgressBar('discovering verboticons [:bar] :current/:total :percent :etas', {
    total: numEmoji,
    width: 80
  })

  const verboticons = []
  for (let i = 0; i < numEmoji; i++) {
    const emoji = emojis[i]

    if (emoji.alias) {
      bar.tick()
      continue
    }

    const isVerboticon = await determineVerboticon(emoji)
    if (isVerboticon) {
      verboticons.push(emoji)
    }

    bar.tick()
  }

  return verboticons
}

async function main() {
  const client = new WebClient(slackToken)
  const emojis = await getAllEmoji(client)
  await downloadAllEmoji(emojis)
  const verboticons = await findAllVerboticons(emojis)

  // console.log(verboticons.map(emoji => `:${emoji.name}:`).join(' '))

  // TODO: add white background to all verboticons
  // TODO: figure out whether we want to manually upload replacements or partition among volunteers
  // TODO: remember to deal with aliases
}

main()
