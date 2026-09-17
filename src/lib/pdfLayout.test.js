import test from 'node:test'
import assert from 'node:assert/strict'
import { layoutToText } from './pdfLayout.js'

const BODY = 8
// One text run on a two-column, 600pt-wide page. Columns: 40–290 and 310–560.
const run = (str, x, y, extra = {}) => ({ str, x, y, w: str.length * 4, h: BODY, ...extra })
const sup = (str, x, y) => ({ str, x, y: y + 3.5, w: str.length * 2.4, h: 4.8 })
const filler = (col, fromY, count) => Array.from({ length: count }, (_, i) => run('Plain body text that fills the column to set the body size.', col, fromY - i * 10))

test('reads the left column before the right and keeps marked superscripts', () => {
  const left = 'Bypass lowers the risk of amputation'
  const page = {
    width: 600,
    height: 800,
    items: [
      run('Right column comes second.', 310, 700),
      run(left, 40, 700), sup('5,10', 40 + left.length * 4, 700), run('. Next sen-', 40 + left.length * 4 + 10, 700),
      run('tence continues here.', 40, 690),
      ...filler(40, 680, 6), ...filler(310, 690, 6),
    ],
  }
  const text = layoutToText([page])
  assert.ok(text.includes('Bypass lowers the risk of amputation^{5,10}. Next sentence continues here.'))
  assert.ok(text.indexOf('Next sentence') < text.indexOf('Right column comes second.'))
})

test('keeps a hanging reference number on its entry and starts each entry on a new line', () => {
  const page = {
    width: 600,
    height: 800,
    items: [
      run('References', 40, 700),
      run('1.', 40, 690), run('Smith J. Bypass outcomes. https://doi.org/10.1000/', 55, 690),
      run('abc-123 (2020).', 55, 680),
      run('2.', 40, 670), run('Lee K. Stents. Lancet 1, 2 (2021).', 55, 670),
      ...filler(310, 700, 8),
    ],
  }
  const lines = layoutToText([page]).split('\n')
  assert.deepEqual(lines.slice(0, 3), [
    'References',
    '1. Smith J. Bypass outcomes. https://doi.org/10.1000/abc-123 (2020).',
    '2. Lee K. Stents. Lancet 1, 2 (2021).',
  ])
})

test('drops running headers and leaves affiliation superscripts unmarked', () => {
  const name = (str, x) => [run(str, x, 650), sup('1', x + str.length * 4, 650), run(', ', x + str.length * 4 + 3, 650)]
  const pages = [0, 1, 2].map((n) => ({
    width: 600,
    height: 800,
    items: [
      run(`Journal of Testing | page ${n + 1}`, 40, 780),
      ...(n === 0 ? [...name('Ann Author', 40), ...name('Bob Writer', 100), ...name('Cy Third', 160)] : []),
      ...filler(40, 600, 5), ...filler(310, 600, 5),
    ],
  }))
  const text = layoutToText(pages)
  assert.ok(!text.includes('Journal of Testing'))
  assert.ok(!text.includes('^{'))
  assert.ok(text.includes('Ann Author1'))
})
