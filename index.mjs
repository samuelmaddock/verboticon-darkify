import process from 'process'
import { exec } from 'child_process'
import fs from 'fs-extra'
import path from 'path'
import { fileURLToPath } from 'url'
import fetch from 'node-fetch'
import slack from '@slack/client'
import ProgressBar from 'progress'
import emojme from 'emojme'
import prompts from 'prompts'

const { WebClient } = slack

import emojiRemove from './slack-emoji-remove.mjs'

// USAGE: npm start [emoji_name1, emoji_name2...]

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CACHE_DIR = path.join(__dirname, '/.cache')
const OUTPUT_DIR = path.join(__dirname, '/dist')
const BACKGROUND_PATH = path.join(__dirname, 'background.svg')

const argEmojis = process.argv.slice(2)

const slackToken = process.env.SLACK_ACCESS_TOKEN
if (typeof slackToken !== 'string') {
  console.error('Must define SLACK_ACCESS_TOKEN env var')
  process.exit(1)
}

const slackWorkspace = process.env.SLACK_WORKSPACE
if (typeof slackWorkspace !== 'string') {
  console.error('Must define SLACK_WORKSPACE env var')
  process.exit(1)
}

const slackUserToken = process.env.SLACK_USER_TOKEN
if (typeof slackUserToken !== 'string') {
  console.error('Must define SLACK_USER_TOKEN env var')
  process.exit(1)
}

const IS_DRY_RUN = Boolean(process.env.DRY_RUN)

const escapePath = filepath => filepath.replace(/'/g, "\\'")

async function getAllEmoji(client) {
  const result = await client.emoji.list()
  const { emoji } = result
  const emojis = Object.entries(emoji).map(([name, uri]) => {
    const isAlias = uri.startsWith('alias:')
    if (isAlias) {
      return { uri, name, alias: uri.substr('alias:'.length) }
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
const GRAYSCALE_CHANNEL_REGEX = /Gray:/i
async function getColorData(filepath) {
  const data = {}

  const output = await new Promise((resolve, reject) => {
    const cmd = `identify -verbose ${escapePath(filepath)}`
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
  data.grayscale = Boolean(output.match(GRAYSCALE_CHANNEL_REGEX))

  return data
}

const COLOR_NONE = '#00000000'
const COLOR_BLACK = '#000000FF'

async function determineVerboticon(emoji) {
  // NOTE: commented out to avoid replacing verboticons already updated to
  // support dark mode (already have white background)
  // if (emoji.name.includes('verboticon')) return true

  // skip gifs
  if (path.extname(emoji.uri) === '.gif') return false

  const { histogram, numPixels, grayscale } = await getColorData(emoji.filepath)
  const numTransparentPixels = histogram[COLOR_NONE] || 0
  const numBlackPixels = histogram[COLOR_BLACK] || 0
  const percentPrimary = (numTransparentPixels + numBlackPixels) / numPixels
  const isLikelyVerboticon =
    grayscale && numTransparentPixels > numBlackPixels && numBlackPixels > 0 && percentPrimary > 0.9

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

function writeBackgroundColor(src, dest) {
  return new Promise((resolve, reject) => {
    const cmd = `composite -background transparent ${escapePath(src)} ${BACKGROUND_PATH} ${escapePath(dest)}`
    exec(cmd, (err, stdout) => {
      if (err) {
        reject(err)
        return
      }
      resolve(stdout)
    })
  })
}

// Processes verboticons to add background colors
async function processVerboticons(emojis) {
  await fs.ensureDir(OUTPUT_DIR)

  const numEmoji = emojis.length
  const bar = new ProgressBar('processing verboticons [:bar] :current/:total :percent :etas', {
    total: numEmoji,
    width: 80
  })

  for (let i = 0; i < numEmoji; i++) {
    const emoji = emojis[i]
    const src = emoji.filepath
    const dest = path.join(OUTPUT_DIR, emoji.filename)
    await writeBackgroundColor(src, dest)
    bar.tick()
  }
}

async function removeEmoji(emoji) {
  await emojiRemove(slackWorkspace, slackUserToken, { name: emoji.name })
}

async function addEmoji(emoji) {
  const src = path.join(OUTPUT_DIR, emoji.filename)
  await emojme.add(slackWorkspace, slackUserToken, {
    src,
    name: emoji.name,
    allowCollisions: true // prevent fetching emoji list each upload
  })
}

async function restoreEmojiAliases(emoji, allEmojis) {
  const aliases = allEmojis.filter(e => e.alias === emoji.name).map(e => e.name)

  for (let i = 0; i < aliases.length; i++) {
    await emojme.add(slackWorkspace, slackUserToken, {
      name: aliases[i],
      aliasFor: emoji.name,
      allowCollisions: true // prevent fetching emoji list each upload
    })
  }
}

async function replaceVerboticons(verboticons, emojis) {
  const numVerboticons = verboticons.length
  const bar = new ProgressBar('replacing verboticons [:bar] :current/:total :percent :etas', {
    total: numVerboticons,
    width: 80
  })

  for (let i = 0; i < numVerboticons; i++) {
    const verboticon = verboticons[i]
    await removeEmoji(verboticon)
    await addEmoji(verboticon)
    await restoreEmojiAliases(verboticon, emojis)
    bar.tick()
  }
}

async function main() {
  const client = new WebClient(slackToken)
  const emojis = await getAllEmoji(client)
  await downloadAllEmoji(emojis)

  let verboticons

  if (argEmojis.length > 0) {
    verboticons = argEmojis.map(emojiName => emojis.find(emoji => emoji.name === emojiName)).filter(Boolean)
  } else {
    verboticons = await findAllVerboticons(emojis)
  }

  if (verboticons.length === 0) {
    console.log('No verboticons found')
    return
  }

  const emojiList = verboticons.map(emoji => `:${emoji.name}:`).join(' ')
  console.log(`Found ${verboticons.length} verboticons:\n${emojiList}`)

  if (IS_DRY_RUN) return

  const response = await prompts({
    type: 'confirm',
    name: 'value',
    message: 'Looks good?',
    initial: true
  })
  if (!response.value) return

  await processVerboticons(verboticons)
  await replaceVerboticons(verboticons, emojis)

  console.log('done!')
}

main()
