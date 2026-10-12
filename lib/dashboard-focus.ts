import type { SavedAssignment } from "./workspace-codec";

export function dashboardFocus(assignments: SavedAssignment[]) {
  return assignments.filter((assignment) => assignment.status !== "done").sort((first, second) => {
    if (!first.dateKey || !second.dateKey) return Number(!first.dateKey) - Number(!second.dateKey);
    return first.dateKey.localeCompare(second.dateKey) || (first.dueTime || "23:59").localeCompare(second.dueTime || "23:59") || first.title.localeCompare(second.title);
  });
}
