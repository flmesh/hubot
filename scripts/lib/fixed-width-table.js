function truncateCell(value, width) {
  const normalized = String(value ?? "-").replace(/\s+/g, " ").trim() || "-";
  if (normalized.length <= width) {
    return normalized;
  }
  if (width <= 1) {
    return normalized.slice(0, width);
  }
  return `${normalized.slice(0, width - 1)}…`;
}

function padCell(value, width) {
  return truncateCell(value, width).padEnd(width, " ");
}

export function renderFixedWidthTable(columns, rows) {
  const header = columns.map((column) => padCell(column.label, column.width)).join(" ");
  const lines = rows.map((row) =>
    columns.map((column) => padCell(row[column.key], column.width)).join(" "),
  );

  return [header, ...lines].join("\n");
}