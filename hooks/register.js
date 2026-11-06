// Ask Notch: Claude's questions as a native card at the notch.
//
// Claude's AskUserQuestion is answered from helper/card.js, a one-shot window drawn by macOS's
// built-in script runner (osascript, JavaScript for Automation). Esc at the card, a timeout, or a
// card that can't start falls back to Claude Code's own dialog, so a question is never lost.

const CARD_TIMEOUT_S = 540
const COMPANIONS = ['cat', 'off']
// Added to Claude's system prompt while cards are on (the ask-at-the-notch skill says the same at length).
const CHOICES_NOTE = '# Ask Notch\nAsk Notch is installed and on: an AskUserQuestion call shows as a card at the top of the person\'s screen, answered with one click from any app. So whenever your reply would offer the person two or more options to pick from (approaches, designs, names, which way to go) or end by asking which they prefer, do not write that list. Call AskUserQuestion instead: one single-choice question, 2-4 options with short labels, your pick first with " (Recommended)" at the end of its label, the reasoning and trade-off in each option\'s description. Then continue with the answer. This applies even when they ask you to help them decide: give your pick as the recommended option. Only skip the card when there is truly one sensible way to do it.'

export function register(on) {
  on('session.start', async ($, e, next) => {
    try {
      await $.command.register({
        name: 'notch',
        description: 'Claude questions at the notch. Say what you want: "put it by my cursor", "pause", "bring the cat", "test"',
        argumentHint: '[anything, e.g. "put it by my cursor"]',
        immediate: true,
      })
      // Claude reads whatever follows /notch and changes the setting through this tool.
      await $.tool.register({
        name: 'settings',
        description: 'Read or change Ask Notch, the plugin that shows your AskUserQuestion questions as a card at the Mac\'s notch. Every field is optional; leave all out to read the current settings. on: false sends questions to Claude Code\'s own dialog instead. at: where the card opens, "notch" (drops from the top of the screen) or "cursor" (beside the mouse pointer). companion: "cat" shows an animated cat beside the card, "off" hides it. test: true shows a sample card so the person can see it working. Returns the settings after the change.',
        inputSchema: {
          type: 'object',
          properties: {
            on: { type: 'boolean' },
            at: { type: 'string', enum: ['notch', 'cursor'] },
            companion: { type: 'string', enum: COMPANIONS },
            test: { type: 'boolean' },
          },
        },
      })
    } catch {}
    return next(e)
  })

  // While cards are on, Claude asks its choices with AskUserQuestion, so they arrive at the notch.
  on('prompt.compose', async ($, e, next) => {
    const r = await next(e)
    const cfg = await loadCfg($)
    if (!cfg.on) return r
    return { sections: [...r.sections, { id: 'ask-notch:choices', text: CHOICES_NOTE, scope: 'session' }] }
  })

  on('command.run', { command: 'notch' }, async ($, e) => {
    const said = (e.args || '').trim()
    const cfg = await loadCfg($)
    if (!said) return { text: describe(cfg) + ' · say what you want, e.g. /notch put it by my cursor' }
    // The exact words still work instantly; anything else is read by Claude.
    const exact = parseExact(said)
    if (exact) {
      const r = await apply($, cfg, exact)
      return { text: describe(r.cfg) + (r.test ? ' · test card → ' + JSON.stringify(r.test) : '') }
    }
    // A command.run hook can't submit (it holds the turn); queue it to run just after the command returns.
    $.clock.after(50, () => $.prompt.submit({
      text: 'The person typed `/notch ' + said + '`. Read it as a change to Ask Notch and make it with the mcp__ask-notch__settings tool, then reply in one short line with what changed. If it asks for something the settings cannot do, say so in one line and leave them as they are. Current: ' + describe(cfg) + '.',
    }))
    return { text: 'asking Claude: "' + said + '"…' }
  })

  on('tool.call', { tool: 'mcp__ask-notch__settings' }, async ($, e) => {
    const r = await apply($, await loadCfg($), e)
    return { result: describe(r.cfg) + (r.test ? ' · test card answered: ' + JSON.stringify(r.test) : '') }
  })

  on('tool.call', { tool: 'AskUserQuestion' }, async ($, e, next) => {
    const cfg = await loadCfg($)
    const qs = e.questions || []
    // The card answers single-choice questions; multi-select, text and number go to Claude Code's form.
    if (!cfg.on || !qs.length || qs.some((q) => q.multiSelect || (q.kind && q.kind !== 'choice'))) return next(e)

    // Same shape as Claude Code's own dialog result: question text -> chosen label (or typed text).
    const answers = {}
    let cwd = ''
    try { cwd = await $.session.cwd() } catch {}
    for (const q of qs) {
      // Relay (optional, ~/.ask-notch/relay.json): may mirror this card elsewhere (your phone) and,
      // if it's answered there first, writes answerFile, which the card returns as its answer.
      const phone = await startPhone($, q, cwd)
      const r = await showCard($, {
        title: q.header ? 'Claude asks · ' + q.header : undefined,
        question: q.question,
        answerFile: phone ? phone.answerFile : undefined,
        options: (q.options || []).map((o) => ({
          label: String(o.label).replace(/\s*\(recommended\)\s*$/i, ''),
          detail: o.description,
          recommended: /\(recommended\)\s*$/i.test(String(o.label)),
        })),
      }, cfg)
      if (phone) endPhone($, phone, r)
      // Dismissed, timed out, or the card failed: hand the whole question set to Claude Code's dialog.
      if (!r || r.cancelled || !r.answer) return next(e)
      answers[q.question] = r.answer
    }
    return { result: { questions: qs, answers } }
  })
}

// ── relay: answer the card from somewhere else (your phone) ──
// Off unless ~/.ask-notch/relay.json names a command: {"command": ["/path/to/node", "/path/to/relay.mjs"]}.
// For each card the mod runs `<command> --relay <json>` alongside it, with
//   { key, answerFile, cwd, question, wait }
// The relay may mirror the question anywhere; if it's answered there first, it writes
// {"answer": "...", "typed": bool} to answerFile (always under ~/.ask-notch/answers/) and the card
// returns that as its answer. When the card closes the mod runs `<command> --done <key> <how> <answer>`
// (how: mac | phone | cancelled) so the relay can stop and tidy up.
async function relayConfig($) {
  try {
    const r = await $.process.run(['/bin/sh', '-c', 'printf "%s\\n" "$HOME"; cat "$HOME/.ask-notch/relay.json" 2>/dev/null'], { timeoutMs: 3000 })
    const [home, ...rest] = r.stdout.split('\n')
    const cfg = JSON.parse(rest.join('\n') || 'null')
    const command = cfg && Array.isArray(cfg.command) && cfg.command.length && cfg.command.every((s) => typeof s === 'string') ? cfg.command : null
    return command && home ? { home: home.trim(), command } : null
  } catch { return null }
}
async function startPhone($, q, cwd) {
  const relay = await relayConfig($)
  if (!relay) return null
  try {
    const key = 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
    const answerFile = relay.home + '/.ask-notch/answers/' + key + '.json'
    const spec = { key, answerFile, cwd, question: q, wait: CARD_TIMEOUT_S }
    // Not awaited: it lives as long as the card, and exits when the card is done.
    $.process.run([...relay.command, '--relay', JSON.stringify(spec)], { timeoutMs: (CARD_TIMEOUT_S + 20) * 1000 }).catch(() => {})
    return { key, answerFile, command: relay.command }
  } catch { return null }
}
function endPhone($, phone, r) {
  const how = !r || r.cancelled ? 'cancelled' : r.via === 'phone' ? 'phone' : 'mac'
  try {
    $.process.run([...phone.command, '--done', phone.key, how, String((r && r.answer) || '')], { timeoutMs: 15000 }).catch(() => {})
  } catch {}
}

// The fixed words /notch has always taken: on, off, notch, cursor, companion cat|off, test.
function parseExact(said) {
  const [arg, value, extra] = said.toLowerCase().split(/\s+/)
  if (extra !== undefined) return null
  if ((arg === 'on' || arg === 'off') && !value) return { on: arg === 'on' }
  if ((arg === 'notch' || arg === 'cursor') && !value) return { at: arg }
  if (arg === 'companion' && COMPANIONS.includes(value)) return { companion: value }
  if (arg === 'test' && !value) return { test: true }
  return null
}

async function apply($, cfg, change) {
  if (typeof change.on === 'boolean') cfg.on = change.on
  if (change.at === 'notch' || change.at === 'cursor') cfg.at = change.at
  if (COMPANIONS.includes(change.companion)) cfg.companion = change.companion
  await $.store.set('cfg', cfg)
  let test
  if (change.test) {
    test = await showCard($, {
      question: 'Notch cards are working. Keep Claude\'s questions here?',
      options: [
        { label: 'Keep them here', detail: 'Questions drop from the notch', recommended: true },
        { label: 'Beside the cursor', detail: 'Card opens where you are pointing' },
      ],
    }, cfg)
  }
  return { cfg, test }
}

function describe(cfg) {
  return 'Notch cards ' + (cfg.on ? 'on' : 'off') + ' · at ' + cfg.at + ' · companion ' + cfg.companion
}

async function loadCfg($) {
  const saved = await $.store.get('cfg')
  const cfg = { on: true, at: 'notch', companion: 'off', ...(saved || {}) }
  if (!COMPANIONS.includes(cfg.companion)) cfg.companion = 'off'
  return cfg
}

async function showCard($, spec, cfg) {
  const companion = cfg.companion === 'cat' ? { name: 'cat', dir: 'assets/companion/cat' } : undefined
  // The card names its session so an app on this Mac (wallpap's pets) can call it over (helper/card.js).
  let session
  try { session = await $.session.id() } catch {}
  $.ui.status('question waiting at the ' + cfg.at)
  try {
    // Always the same command: macOS's own osascript running this plugin's helper/card.js. The question
    // goes to it on standard input; its answer comes back on standard output. Nothing leaves the Mac.
    const r = await $.process.run(['/usr/bin/osascript', '-l', 'JavaScript', 'helper/card.js'], {
      cwd: $.plugin.root,
      stdin: JSON.stringify({ ...spec, at: cfg.at, source: 'Claude Code', timeout: CARD_TIMEOUT_S, companion, session }),
      timeoutMs: (CARD_TIMEOUT_S + 15) * 1000,
    })
    const line = r.stdout.trim().split('\n').pop()
    return line ? JSON.parse(line) : null
  } catch {
    return null
  } finally {
    $.ui.status(undefined)
  }
}
