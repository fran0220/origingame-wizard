import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { WizardError } from './errors.js'
import { acceptable, normalizeImage, type ImageKind } from './image.js'
import type { ModelClient } from './model.js'
import { openInBrowser } from './open.js'
import { parseSize, type Rules } from './rules.js'
import { ARTWORK_SCHEMA, type Metadata } from './tasks.js'
import type { Ui } from './ui.js'

export interface Artwork { cover: Buffer; poster: Buffer; coverPath: string; posterPath: string }

interface Candidate { kind: ImageKind; index: number; file: string; prompt: string }

function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
}

function previewPage(dir: string, title: string, candidates: Candidate[]): string {
  const card = (c: Candidate) => `<figure><img src="${path.basename(c.file)}" alt=""><figcaption>${c.kind} ${c.index}</figcaption></figure>`
  const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} artwork</title>
<style>:root{color-scheme:light dark;font-family:system-ui,sans-serif}body{margin:24px;background:Canvas;color:CanvasText}h1{font-size:20px}h2{font-size:15px;margin-top:28px}
.row{display:flex;flex-wrap:wrap;gap:16px}figure{margin:0}img{display:block;border-radius:10px;box-shadow:0 2px 10px #0004}
.cover img{width:min(460px,90vw)}.poster img{width:min(260px,60vw)}figcaption{margin-top:6px;font-size:13px;opacity:.75;text-transform:capitalize}</style>
<h1>${escapeHtml(title)}</h1><p>Pick one cover and one poster in your terminal.</p>
<h2>Cover (16:9)</h2><div class="row cover">${candidates.filter(c => c.kind === 'cover').map(card).join('')}</div>
<h2>Poster (3:4)</h2><div class="row poster">${candidates.filter(c => c.kind === 'poster').map(card).join('')}</div>`
  const file = path.join(dir, 'preview.html')
  fs.writeFileSync(file, html)
  return file
}

/** The person's own image, checked and normalized the same way as a generated one. */
async function ownImage(ui: Ui, kind: ImageKind, output: { width: number; height: number }, maxBytes: number): Promise<Buffer | null> {
  const file = await ui.text(`Path to your ${kind} image (PNG or JPEG)`, '', v => (fs.existsSync(v) ? undefined : 'file not found'))
  try {
    return normalizeImage(kind, fs.readFileSync(file), output, maxBytes)
  } catch (error) {
    ui.warn(`${file}: ${(error as Error).message}`)
    return null
  }
}

/**
 * Cover and poster: DeepSeek writes the prompts, the image model draws them
 * from text alone (no screenshots, no reference image), candidates run in
 * parallel, and each is cropped and scaled to the exact size Portal accepts.
 */
export async function makeArtwork(client: ModelClient, rules: Rules, ui: Ui, dir: string, input: { metadata: Metadata; summary: string; engine: string }): Promise<Artwork> {
  fs.mkdirSync(dir, { recursive: true })
  // Candidates exist so a person can choose; a run without prompts draws one of each.
  const count = { cover: ui.interactive ? rules.images.cover.candidates : 1, poster: ui.interactive ? rules.images.poster.candidates : 1 }
  const promptModel = client.textModel(rules.models.analyze)
  const imageModel = client.imageModel(rules.models.image)
  const s = ui.spinner('Writing artwork prompts')
  const prompts = await client.json<{ cover: string[]; poster: string[] }>({
    model: promptModel, system: rules.prompts.system, task: 'artwork', instructions: rules.prompts.artwork, schema: ARTWORK_SCHEMA, failure: 'artwork_failed',
    input: {
      title: input.metadata.title, tagline: input.metadata.tagline, description: input.metadata.description, genre: input.metadata.genre,
      art_direction: input.metadata.art_direction ?? '', summary: input.summary, engine: input.engine,
      cover: { aspect: '16:9', candidates: count.cover }, poster: { aspect: '3:4', candidates: count.poster },
    },
  })
  s.stop('Artwork prompts ready')

  const generate = async (kind: ImageKind, attempt: number): Promise<Candidate[]> => {
    const rule = rules.images[kind]
    const output = parseSize(rule.output)
    const list = prompts[kind].filter(p => p.trim()).slice(0, count[kind])
    if (!list.length) throw new WizardError('artwork_failed', `the artwork prompts had no ${kind}`)
    const settled = await Promise.allSettled(list.map(async (prompt, i) => {
      const image = await client.image(imageModel, prompt, rule.size, rule.fallback)
      const bytes = normalizeImage(kind, image.bytes, output, rules.limits.portal.maxImageBytes)
      const file = path.join(dir, `${kind}-${attempt}-${i + 1}.jpg`)
      fs.writeFileSync(file, bytes)
      return { kind, index: i + 1, file, prompt }
    }))
    const ok = settled.flatMap(r => (r.status === 'fulfilled' ? [r.value] : []))
    if (!ok.length) {
      const reason = settled.find((r): r is PromiseRejectedResult => r.status === 'rejected')?.reason
      throw reason instanceof WizardError ? reason : new WizardError('artwork_failed', `no ${kind} could be generated: ${(reason as Error)?.message ?? 'unknown error'}`)
    }
    return ok
  }

  let attempt = 1
  for (;;) {
    const g = ui.spinner(count.cover === 1 && count.poster === 1 ? `Drawing a cover and a poster with ${imageModel}` : `Drawing ${count.cover} cover and ${count.poster} poster candidates with ${imageModel}`)
    let candidates: Candidate[]
    try {
      const [covers, posters] = await Promise.all([generate('cover', attempt), generate('poster', attempt)])
      candidates = [...covers, ...posters]
      g.stop(`Drew ${covers.length} cover${covers.length === 1 ? '' : 's'} and ${posters.length} poster${posters.length === 1 ? '' : 's'}`)
    } catch (error) {
      g.fail('Artwork generation failed')
      throw error
    }
    const preview = previewPage(dir, input.metadata.title, candidates)
    ui.info(`Artwork preview: ${pathToFileURL(preview).href}`)
    for (const c of candidates) ui.info(`  ${c.kind} ${c.index}: ${c.file}`)
    if (ui.interactive && (await ui.confirm('Open the artwork preview in your browser?', true))) openInBrowser(pathToFileURL(preview).href)

    const pick = async (kind: ImageKind): Promise<Buffer | 'again'> => {
      const options = candidates.filter(c => c.kind === kind)
      const choice = await ui.select<string>(`Choose the ${kind}`, [
        ...options.map(c => ({ value: c.file, label: `${kind} ${c.index}`, hint: path.basename(c.file) })),
        { value: 'again', label: 'Draw new candidates' },
        { value: 'own', label: 'Use my own image file' },
      ], options[0]!.file)
      if (choice === 'again') return 'again'
      if (choice === 'own') {
        const own = await ownImage(ui, kind, parseSize(rules.images[kind].output), rules.limits.portal.maxImageBytes)
        return own ?? fs.readFileSync(options[0]!.file)
      }
      return fs.readFileSync(choice)
    }
    const cover = await pick('cover')
    if (cover === 'again') { attempt++; continue }
    const poster = await pick('poster')
    if (poster === 'again') { attempt++; continue }
    if (!acceptable('cover', cover, rules.limits.portal.maxImageBytes) || !acceptable('poster', poster, rules.limits.portal.maxImageBytes)) throw new WizardError('artwork_failed', 'the chosen artwork does not meet the platform image rules')
    const coverPath = path.join(dir, 'cover.jpg')
    const posterPath = path.join(dir, 'poster.jpg')
    fs.writeFileSync(coverPath, cover)
    fs.writeFileSync(posterPath, poster)
    return { cover, poster, coverPath, posterPath }
  }
}
