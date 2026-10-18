export const categories = ['tarea', 'recordatorio', 'idea', 'nota'];
export function validateItems(items) {
  if (!Array.isArray(items) || !items.length || items.length > 30) throw new Error('Se requieren entre 1 y 30 elementos.');
  return items.map(item => {
    if (!item || typeof item.title !== 'string' || !item.title.trim() || item.title.length > 300 || !categories.includes(item.category)) throw new Error('Título o categoría inválidos.');
    const project = item.project == null ? null : String(item.project).trim();
    if (project && project.length > 100) throw new Error('Proyecto demasiado largo.');
    const dueDate = item.dueDate || null;
    if (dueDate && (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate) || new Date(dueDate).toISOString().slice(0,10) !== dueDate)) throw new Error('Fecha inválida.');
    return { title: item.title.trim(), category: item.category, project: project || null, dueDate, done: Boolean(item.done) };
  });
}
export function fallbackItems(text) {
  return [{ title: text.slice(0, 150), category: 'nota', project: null, dueDate: null, done: false }];
}
