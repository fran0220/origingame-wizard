export default async function init(bytes) { const { instance } = await WebAssembly.instantiate(bytes); return instance }
