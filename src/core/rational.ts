// 只解析有界的四则运算；不执行模型提供的 JavaScript、代码或命令。
interface Rational { n: bigint; d: bigint }

function rational(n: bigint, d: bigint): Rational {
  if (d === 0n) throw new Error('除数不能为零')
  if (d < 0n) { n = -n; d = -d }
  let a = n < 0n ? -n : n
  let b = d
  while (b !== 0n) { const r = a % b; a = b; b = r }
  n /= a; d /= a
  if (n.toString().length > 100 || d.toString().length > 100) throw new Error('运算结果过大')
  return { n, d }
}

export function evaluateRational(expression: string): string {
  if (expression.length > 256 || !/^[\d\s.+*/()\-]+$/.test(expression)) throw new Error('仅支持有界数字四则运算')
  const tokens = expression.match(/\d+(?:\.\d+)?|[()+*/\-]/g) ?? []
  if (tokens.join('') !== expression.replace(/\s/g, '') || tokens.length > 128) throw new Error('算式格式错误')
  let index = 0
  function atom(): Rational {
    const token = tokens[index++]
    if (token === '+' || token === '-') {
      const value = atom()
      return token === '-' ? { n: -value.n, d: value.d } : value
    }
    if (token === '(') {
      const value = sum()
      if (tokens[index++] !== ')') throw new Error('括号不匹配')
      return value
    }
    if (!token || !/^\d+(?:\.\d+)?$/.test(token) || token.length > 24) throw new Error('数字格式错误')
    const [integer, decimal = ''] = token.split('.')
    return rational(BigInt(integer + decimal), 10n ** BigInt(decimal.length))
  }
  function product(): Rational {
    let value = atom()
    while (tokens[index] === '*' || tokens[index] === '/') {
      const op = tokens[index++]
      const right = atom()
      value = op === '*' ? rational(value.n * right.n, value.d * right.d) : rational(value.n * right.d, value.d * right.n)
    }
    return value
  }
  function sum(): Rational {
    let value = product()
    while (tokens[index] === '+' || tokens[index] === '-') {
      const op = tokens[index++]
      const right = product()
      value = rational(value.n * right.d + (op === '+' ? right.n : -right.n) * value.d, value.d * right.d)
    }
    return value
  }
  const value = sum()
  if (index !== tokens.length) throw new Error('算式含有多余内容')
  return value.d === 1n ? String(value.n) : `${value.n}/${value.d}`
}

export function sameRational(left: string, right: string): boolean | undefined {
  try { return evaluateRational(left) === evaluateRational(right) } catch { return undefined }
}
