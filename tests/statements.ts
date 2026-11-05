/**
 * Split SQL into single statements the way D1 does: semicolons inside string
 * literals or -- / block comments do not end a statement, and chunks that hold
 * only comments (or whitespace) are not statements at all.
 */
export function statements(sql: string): string[] {
  const parts: string[] = [];
  let current = "";
  const push = () => {
    parts.push(current.trim());
    current = "";
  };
  for (let i = 0; i < sql.length; i += 1) {
    const char = sql[i]!;
    if (char === "-" && sql[i + 1] === "-") {
      for (; i < sql.length && sql[i] !== "\n"; i += 1);
      current += " ";
    } else if (char === "/" && sql[i + 1] === "*") {
      for (i += 2; i < sql.length && !(sql[i] === "*" && sql[i + 1] === "/"); i += 1);
      // Step onto the closing "/" so the loop increment lands after the
      // comment; otherwise the trailing "/" leaks into the next chunk.
      i += 1;
      current += " ";
    } else if (char === "'") {
      current += char;
      for (i += 1; i < sql.length; i += 1) {
        current += sql[i];
        if (sql[i] === "'") break;
      }
    } else if (char === ";") {
      push();
    } else {
      current += char;
    }
  }
  push();
  return parts.filter(Boolean);
}
