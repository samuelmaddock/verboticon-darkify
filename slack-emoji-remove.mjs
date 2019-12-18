import SlackClient from 'emojme/lib/slack-client.js'
import Helpers from 'emojme/lib/util/helpers.js'

async function remove(subdomains, tokens, options) {
  subdomains = Helpers.arrayify(subdomains)
  tokens = Helpers.arrayify(tokens)
  options = options || {}

  const emojiName = options.name

  if (!emojiName) {
    throw new Error('emoji.remove request must include a name')
  }

  const slack = new SlackClient(subdomains[0], SlackClient.rateLimitTier(2))
  const payload = {
    token: tokens[0],
    name: emojiName,
    _x_reason: 'customize-emoji-remove',
    _x_mode: 'online'
  }
  const result = await slack.request('/emoji.remove', payload)

  if (!result.ok) {
    throw new Error(`Error attempting to remove emoji '${emojiName}': ${result.error}`)
  }
}

export default remove
