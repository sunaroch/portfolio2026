(() => {
  const queryEl = document.getElementById('hero-query')
  const caretEl = document.getElementById('hero-caret')
  const splashEl = document.querySelector('.hero-splash')
  const mosaicEl = document.getElementById('hero-mosaic')
  const chromeEl = document.querySelector('.hero-chrome')
  const searchEl = document.querySelector('.hero-search')
  const stageEl = document.querySelector('.hero-stage')
  const leadEl = document.querySelector('.lead')
  const shotEl = document.getElementById('hero-shot')

  if (!queryEl || !splashEl || !mosaicEl) return

  const MOSAIC_GAP_PX = 8
  const MOSAIC_MIN_COL_PX = 160
  const WAVE_COL_MS = 170
  const WAVE_ROW_MS = 58
  const TILE_FADE_MS = 720
  const TILE_FADE_OUT_MS = 900
  const BEAT_AFTER_SEARCH = 680
  const BEAT_AFTER_RESULTS = 4200
  const BEAT_BEFORE_NEXT = 420
  const MAX_TILES = 140
  const EAGER_TILES = 24
  const WARM_CONCURRENCY = 5
  const REVEAL_DECODE_BUDGET_MS = 1100
  const DROP_FLIGHT_MS = 900
  const DROP_HINT = 'Drop image to find lookalikes'

  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const nextFrame = () =>
    new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))

  let searches = []

  function normalizeImage(img) {
    if (typeof img === 'string') return { file: img, w: 1, h: 1 }
    return { file: img.file, w: img.w || 1, h: img.h || 1 }
  }

  function mosaicInnerWidth() {
    const stage = stageEl || mosaicEl
    const avail = stage && stage.clientWidth ? stage.clientWidth : window.innerWidth
    const root = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16
    const mobile = window.matchMedia('(max-width: 560px)').matches
    const max = mobile ? 44 * root : 80 * root
    return Math.min(max, avail * 0.94)
  }

  function mosaicColumnCount(width) {
    return Math.max(1, Math.floor((width + MOSAIC_GAP_PX) / (MOSAIC_MIN_COL_PX + MOSAIC_GAP_PX)))
  }

  function mosaicTargetHeight() {
    const stage = stageEl || document.querySelector('.hero')
    if (!stage) return 760
    const root = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16
    const topPad = Math.min(7 * root, Math.max(4.5 * root, stage.clientHeight * 0.08))
    return stage.clientHeight - topPad + 720
  }

  function shuffle(list) {
    const out = list.slice()
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[out[i], out[j]] = [out[j], out[i]]
    }
    return out
  }

  function buildAbundantMosaic(sourceItems, colCount, colWidth, targetHeight) {
    if (!sourceItems.length) return { items: [], columns: [] }

    const items = []
    const columns = Array.from({ length: colCount }, () => [])
    const heights = Array(colCount).fill(0)
    const minTiles = colCount * 5

    // Every column has to clear targetHeight, otherwise a short column runs
    // out of tiles partway through the pan and leaves a gap on screen.
    const filled = () => items.length >= minTiles && Math.min(...heights) >= targetHeight

    let pool = shuffle(sourceItems)
    let cursor = 0
    let lastFile = ''

    while (items.length < MAX_TILES) {
      if (cursor >= pool.length) {
        // A board with plenty of results never gets here. Small boards do, and
        // reusing their images beats leaving dead space below the fold.
        if (filled()) break
        pool = shuffle(sourceItems)
        if (pool.length > 1 && pool[0].file === lastFile) pool.push(pool.shift())
        cursor = 0
      }

      const source = pool[cursor++]
      lastFile = source.file

      // Shortest column, but never one already ending in this same image —
      // a repeat stacked directly on itself is the tell that gives it away.
      let best = -1
      for (let c = 0; c < colCount; c++) {
        const col = columns[c]
        const tail = col.length ? items[col[col.length - 1]].file : ''
        if (tail === source.file) continue
        if (best < 0 || heights[c] < heights[best]) best = c
      }
      if (best < 0) {
        best = 0
        for (let c = 1; c < colCount; c++) {
          if (heights[c] < heights[best]) best = c
        }
      }

      const item = { ...source }
      const itemIdx = items.length
      items.push(item)
      columns[best].push(itemIdx)

      const aspect = item.w > 0 && item.h > 0 ? item.w / item.h : 1
      heights[best] += colWidth / aspect + MOSAIC_GAP_PX

      if (filled()) break
    }

    return { items, columns }
  }

  function waveInDelay(col, row) {
    return col * WAVE_COL_MS + row * WAVE_ROW_MS
  }

  function waveOutDelay(col, row) {
    return col * WAVE_COL_MS + row * WAVE_ROW_MS
  }

  // Warming every board up front means hundreds of parallel requests fighting
  // the wave animation for network and decode time, which is what made the
  // reveal stutter. Instead each board is warmed just before its turn, a few
  // images at a time, during a beat when nothing is moving.
  const warmedBoards = new Set()
  const warmQueue = []
  let warmActive = 0

  function pumpWarmQueue() {
    while (warmActive < WARM_CONCURRENCY && warmQueue.length) {
      const url = warmQueue.shift()
      warmActive += 1
      const el = new Image()
      const done = () => {
        warmActive -= 1
        pumpWarmQueue()
      }
      el.onload = done
      el.onerror = done
      el.src = url
    }
  }

  function warmBoard(search) {
    if (!search || warmedBoards.has(search.board)) return
    warmedBoards.add(search.board)
    for (const img of search.images) {
      warmQueue.push(`public/searchables/hero/${search.board}/${normalizeImage(img).file}`)
    }
    pumpWarmQueue()
  }

  /**
   * Hold the wave until the tiles it is about to move have decoded pixels. A
   * decode landing mid-transition drops frames, so it is better to wait a beat
   * than to animate placeholders. Capped so a slow image can never stall the
   * loop.
   */
  function awaitTileDecode(imgs) {
    if (!imgs.length) return Promise.resolve()
    const all = Promise.all(
      imgs.map((img) => (img.decode ? img.decode() : Promise.resolve()).catch(() => {})),
    )
    return Promise.race([all, sleep(REVEAL_DECODE_BUDGET_MS)])
  }

  function resetMosaic() {
    splashEl.classList.remove('is-live', 'is-leaving')
    stageEl?.classList.remove('is-live', 'is-leaving')
    chromeEl?.classList.remove('is-results')
    mosaicEl.replaceChildren()
  }

  function freezeMosaicScroll() {
    const inner = mosaicEl.querySelector('.hero-mosaic-inner')
    if (!inner) return
    const t = window.getComputedStyle(inner).transform
    inner.style.animation = 'none'
    inner.style.transform = t === 'none' ? '' : t
  }

  let mosaicGen = 0

  async function showMosaic(search) {
    const gen = ++mosaicGen
    resetMosaic()
    // The dropped image is the query, so it is not one of its own matches.
    const sourceItems = search.images
      .map(normalizeImage)
      .filter((item) => !search.seed || item.file !== search.seed)
    const mosaicWidth = mosaicInnerWidth()
    const colCount = mosaicColumnCount(mosaicWidth)
    const colWidth = Math.max(72, (mosaicWidth - MOSAIC_GAP_PX * (colCount - 1)) / colCount)
    const { items, columns } = buildAbundantMosaic(
      sourceItems,
      colCount,
      colWidth,
      mosaicTargetHeight(),
    )

    const inner = document.createElement('div')
    inner.className = 'hero-mosaic-inner'

    let tileCount = 0
    const eagerImgs = []
    columns.forEach((col, colIdx) => {
      const colEl = document.createElement('div')
      colEl.className = 'hero-mosaic-col'
      col.forEach((itemIdx, rowIdx) => {
        const item = items[itemIdx]
        const tile = document.createElement('div')
        tile.className = 'hero-tile'
        tile.dataset.col = String(colIdx)
        tile.dataset.row = String(rowIdx)
        tile.style.transitionDelay = `${waveInDelay(colIdx, rowIdx)}ms`
        tileCount += 1
        const img = document.createElement('img')
        img.src = `public/searchables/hero/${search.board}/${item.file}`
        img.alt = ''
        const eager = tileCount <= EAGER_TILES
        img.loading = eager ? 'eager' : 'lazy'
        img.decoding = 'async'
        img.width = item.w
        img.height = item.h
        img.style.aspectRatio = `${item.w} / ${item.h}`
        if (eager) eagerImgs.push(img)
        tile.append(img)
        colEl.append(tile)
      })
      if (colEl.childElementCount > 0) inner.append(colEl)
    })

    const port = document.createElement('div')
    port.className = 'hero-mosaic-port'
    port.append(inner)
    inner.classList.add('is-waving')
    mosaicEl.append(port)

    // Let the new subtree lay out and decode first, so the frame that starts
    // the wave has nothing left to do but composite.
    await nextFrame()
    await awaitTileDecode(eagerImgs)
    await nextFrame()
    // A resize mid-decode already replaced this mosaic; let its build win.
    if (gen !== mosaicGen) return

    splashEl.classList.add('is-live')
    stageEl?.classList.remove('is-leaving')
    stageEl?.classList.add('is-live')
    chromeEl?.classList.add('is-results')

    // Drop the compositing hints once the tiles have settled rather than
    // holding a layer per tile for the whole 16s pan.
    const span = waveSpanMs(columns)
    window.setTimeout(() => inner.classList.remove('is-waving'), span)
  }

  function waveSpanMs(columns) {
    let last = 0
    columns.forEach((col, colIdx) => {
      if (col.length) last = Math.max(last, waveInDelay(colIdx, col.length - 1))
    })
    return last + TILE_FADE_MS
  }

  async function hideMosaic() {
    if (!splashEl.classList.contains('is-live')) {
      resetMosaic()
      return
    }
    freezeMosaicScroll()
    mosaicEl.querySelector('.hero-mosaic-inner')?.classList.add('is-waving')
    const tiles = [...mosaicEl.querySelectorAll('.hero-tile')]
    let maxOut = 0
    tiles.forEach((tile) => {
      const col = Number(tile.dataset.col) || 0
      const row = Number(tile.dataset.row) || 0
      const delay = waveOutDelay(col, row)
      maxOut = Math.max(maxOut, delay)
      tile.style.transitionDelay = `${delay}ms`
    })
    // Freeze and re-delay in one pass, then start the exit on a clean frame.
    await nextFrame()
    splashEl.classList.add('is-leaving')
    splashEl.classList.remove('is-live')
    stageEl?.classList.add('is-leaving')
    stageEl?.classList.remove('is-live')
    chromeEl?.classList.remove('is-results')
    await sleep(maxOut + TILE_FADE_OUT_MS)
    resetMosaic()
  }

  function clearShot() {
    if (!shotEl) return
    shotEl.hidden = true
    shotEl.classList.remove('is-open', 'is-seated')
    shotEl.querySelector('img')?.removeAttribute('src')
    queryEl.classList.remove('is-hint')
    searchEl?.classList.remove('is-dropping')
  }

  /** Fade the thumbnail out with the results rather than snapping it away. */
  async function closeShot() {
    if (!shotEl || shotEl.hidden) return
    shotEl.classList.add('is-closing')
    shotEl.classList.remove('is-open')
    await sleep(380)
    clearShot()
    shotEl.classList.remove('is-closing')
  }

  function seatShot(search) {
    if (!shotEl || !search.seed) return
    const img = shotEl.querySelector('img')
    if (img) img.src = `public/searchables/hero/${search.board}/${search.seed}`
    shotEl.hidden = false
    shotEl.classList.add('is-open', 'is-seated')
  }

  function show(search) {
    clearShot()
    if (search.mode === 'image') seatShot(search)
    queryEl.textContent = search.q
    showMosaic(search)
  }

  /** Fly the seed image into the search bar instead of typing a query. */
  async function dropImage(search) {
    if (!shotEl || !search.seed) return typeTo(search.q)

    const img = shotEl.querySelector('img')
    if (img) img.src = `public/searchables/hero/${search.board}/${search.seed}`
    shotEl.hidden = false
    shotEl.classList.remove('is-open', 'is-seated')
    if (caretEl) caretEl.hidden = true
    queryEl.classList.add('is-hint')
    queryEl.textContent = DROP_HINT
    searchEl?.classList.add('is-dropping')

    // Commit the lifted start transform before transitioning to seated.
    await nextFrame()
    shotEl.classList.add('is-open', 'is-seated')
    await sleep(DROP_FLIGHT_MS)

    searchEl?.classList.remove('is-dropping')
    queryEl.classList.remove('is-hint')
    queryEl.textContent = search.q
  }

  async function typeTo(text) {
    clearShot()
    queryEl.textContent = ''
    if (caretEl) caretEl.hidden = false
    for (let i = 1; i <= text.length; i++) {
      queryEl.textContent = text.slice(0, i)
      await sleep(28 + Math.random() * 36)
    }
  }

  async function run() {
    let i = 0
    if (caretEl) caretEl.hidden = true
    warmBoard(searches[0])
    while (true) {
      const search = searches[i]
      const mosaicReady = showMosaic(search)
      if (search.mode === 'image') await dropImage(search)
      else await typeTo(search.q)
      await sleep(BEAT_AFTER_SEARCH)
      await mosaicReady
      // Results are up and nothing is animating, so spend the long beat
      // warming the next board instead of racing its wave later.
      warmBoard(searches[(i + 1) % searches.length])
      await sleep(BEAT_AFTER_RESULTS)
      await hideMosaic()
      if (search.mode === 'image') await closeShot()
      await sleep(BEAT_BEFORE_NEXT)
      i = (i + 1) % searches.length
    }
  }

  function start(list) {
    searches = list.length ? shuffle(list) : []
    if (!searches.length) return
    if (reduce) {
      warmBoard(searches[0])
      show(searches[0])
      if (caretEl) caretEl.hidden = true
      return
    }
    run()
  }

  let resizeTimer = 0
  window.addEventListener('resize', () => {
    if (!splashEl.classList.contains('is-live') || !searches.length) return
    window.clearTimeout(resizeTimer)
    resizeTimer = window.setTimeout(() => {
      const idx = searches.findIndex((s) => s.q === queryEl.textContent)
      if (idx >= 0) showMosaic(searches[idx])
    }, 120)
  })

  if (leadEl) {
    requestAnimationFrame(() => leadEl.classList.add('is-in'))
  }

  const awayTarget = stageEl || document.querySelector('.hero')
  if (awayTarget) {
    const away = new IntersectionObserver(
      (entries) => {
        splashEl.classList.toggle('is-away', !entries.some((e) => e.isIntersecting))
      },
      { threshold: 0.08 },
    )
    away.observe(awayTarget)
  }

  fetch('public/searchables/hero/manifest.json?v=hero11c')
    .then((r) => (r.ok ? r.json() : []))
    .then(start)
    .catch(() => start([]))
})()
