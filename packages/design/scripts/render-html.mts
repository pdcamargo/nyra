/**
 * An artboard as a self-contained HTML file.
 *
 * This is the shape the sidecar's raster path wants: the pipeline runs in Node,
 * `renderToStaticMarkup` turns the last stage into a string, and Chromium is
 * handed that string directly via `setContent`. No HTTP server, no port, no
 * bundler, and no React in the browser — which is only true because the emitter
 * produces plain DOM and draws icons as raw SVG rather than as lucide-react
 * components.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { compile, renderArtboard } from '../src/pipeline'

const [file, outPath, wanted] = process.argv.slice(2)
const { doc, theme } = compile(JSON.parse(readFileSync(file, 'utf8')))
const artboard = wanted ? doc.artboards.find((a) => a.id === wanted)! : doc.artboards[0]

const body = renderToStaticMarkup(renderArtboard(artboard, theme))
const html = `<!doctype html><html><head><meta charset="utf-8"><title>${artboard.name}</title><style>html,body{margin:0;padding:0}</style></head><body>${body}</body></html>`

writeFileSync(outPath, html)

const scripts = (html.match(/<script/g) ?? []).length
const external = (html.match(/(?:src|href)="(?!data:)[^"]*"/g) ?? []).length
console.log(`wrote ${outPath}`)
console.log(`  ${html.length} bytes, artboard ${artboard.size.width}x${artboard.size.height}`)
console.log(`  <script> tags: ${scripts}`)
console.log(`  external references: ${external}`)
console.log(`  self-contained: ${scripts === 0 && external === 0}`)
