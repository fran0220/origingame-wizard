// Star Catcher: move the basket with the arrow keys and catch falling stars.
const canvas = document.getElementById('game')
const ctx = canvas.getContext('2d')
const state = { x: 480, score: 0, best: Number(localStorage.getItem('star-catcher-best') || 0), stars: [], level: null, over: false }
const keys = new Set()
addEventListener('keydown', e => keys.add(e.key))
addEventListener('keyup', e => keys.delete(e.key))

fetch('/levels/1.json').then(r => r.json()).then(level => { state.level = level; requestAnimationFrame(tick) })

function endRun() {
  state.over = true
  if (state.score > state.best) {
    state.best = state.score
    localStorage.setItem('star-catcher-best', String(state.best))
  }
}

function tick() {
  if (keys.has('ArrowLeft')) state.x -= 8
  if (keys.has('ArrowRight')) state.x += 8
  if (Math.random() < state.level.spawn) state.stars.push({ x: Math.random() * 960, y: 0 })
  for (const star of state.stars) star.y += state.level.speed
  state.stars = state.stars.filter(star => {
    if (star.y > 500 && Math.abs(star.x - state.x) < 40) { state.score++; return false }
    if (star.y > 540) { endRun(); return false }
    return true
  })
  ctx.fillStyle = '#0b1026'
  ctx.fillRect(0, 0, 960, 540)
  ctx.fillStyle = '#ffd34d'
  for (const star of state.stars) ctx.fillRect(star.x - 4, star.y - 4, 8, 8)
  ctx.fillStyle = '#7fd1ff'
  ctx.fillRect(state.x - 40, 510, 80, 14)
  ctx.fillText(`Score ${state.score}  Best ${state.best}`, 12, 20)
  if (!state.over) requestAnimationFrame(tick)
}
