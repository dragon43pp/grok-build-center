// 试验：有没有办法只读打开 WAL 库而不产生 -wal / -shm
const { DatabaseSync } = require('node:sqlite')
const fs = require('node:fs')
const path = require('node:path')

const target = process.argv[2]

function sidecars(db) {
  const out = {}
  for (const suffix of ['', '-wal', '-shm']) {
    const file = db + suffix
    out[suffix || '(main)'] = fs.existsSync(file) ? fs.statSync(file).size : null
  }
  return out
}

function cleanup(db) {
  for (const suffix of ['-wal', '-shm']) {
    try {
      fs.unlinkSync(db + suffix)
    } catch {}
  }
}

function attempt(label, sqlitePath, options) {
  cleanup(target)
  const before = sidecars(target)
  let result
  try {
    const db = new DatabaseSync(sqlitePath, options)
    try {
      result = `rows=${db.prepare('select count(*) as n from threads').all().length}`
    } finally {
      db.close()
    }
  } catch (error) {
    result = `ERROR ${error.message}`
  }
  const after = sidecars(target)
  const created = Object.keys(after).filter((k) => before[k] === null && after[k] !== null)
  console.log(`  ${label}`)
  console.log(`    ${result}`)
  console.log(`    before=${JSON.stringify(before)}`)
  console.log(`    after =${JSON.stringify(after)}`)
  console.log(`    新建: ${created.length ? created.join(', ') : '（无）'}`)
}

console.log(`目标: ${target}`)
attempt('A. readOnly 原路径', target, { readOnly: true })
attempt('B. file: URI + immutable=1', `file:${path.resolve(target).replace(/\\/g, '/')}?immutable=1`, {
  readOnly: true
})
attempt('C. file: URI + mode=ro', `file:${path.resolve(target).replace(/\\/g, '/')}?mode=ro`, {
  readOnly: true
})
cleanup(target)
