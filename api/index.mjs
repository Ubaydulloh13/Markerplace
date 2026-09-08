import {server} from '../server.mjs'

export default function handler(req, res) {
  return server.emit('request', req, res)
}
