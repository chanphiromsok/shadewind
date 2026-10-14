// root of the shadewind checkout: SHADEWIND_ROOT, or the repository this spike lives in
const path = require('node:path')

module.exports = {
  dependencies: {
    shadewind: { root: process.env.SHADEWIND_ROOT ?? path.resolve(__dirname, '../..') },
  },
}
