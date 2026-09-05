import {spawn} from 'node:child_process'
import {fileURLToPath} from 'node:url'
import {dirname,join} from 'node:path'
const root=dirname(fileURLToPath(import.meta.url))
const run=file=>spawn(process.execPath,[file],{cwd:root,stdio:'inherit'})
const backend=run(join(root,'server.mjs'))
const frontend=run(join(root,'node_modules','vite','bin','vite.js'))
const stop=()=>{backend.kill();frontend.kill();process.exit()}
process.on('SIGINT',stop);process.on('SIGTERM',stop)
backend.on('exit',code=>{if(code&&code!==0){console.error('Backend to‘xtadi');frontend.kill();process.exit(code)}})
frontend.on('exit',code=>{backend.kill();process.exit(code||0)})
