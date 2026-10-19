self.onmessage = () => { const tiles = []; let s = 7; for (let i = 0; i < 64; i++) { s = (s * 1103515245 + 12345) >>> 0; tiles.push(s % 4) } self.postMessage({ tiles }) }
