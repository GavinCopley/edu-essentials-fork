"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Search, SlidersHorizontal, X } from "lucide-react";
import type { Course } from "../lib/academics";
import "./files-browser-tools.css";

export type BrowserSearchScope = "folder" | "all";
export type BrowserFileType = "all" | "text" | "pdf" | "image" | "other";
export type BrowserSortBy = "name" | "modified";
export type BrowserSortDirection = "asc" | "desc";

type Props = {
  query: string;
  onQueryChange: (query: string) => void;
  searchScope: BrowserSearchScope;
  onSearchScopeChange: (scope: BrowserSearchScope) => void;
  courseFilter: string;
  onCourseFilterChange: (courseId: string) => void;
  fileType: BrowserFileType;
  onFileTypeChange: (fileType: BrowserFileType) => void;
  sortBy: BrowserSortBy;
  onSortByChange: (sortBy: BrowserSortBy) => void;
  sortDirection: BrowserSortDirection;
  onSortDirectionChange: (direction: BrowserSortDirection) => void;
  includeArchived: boolean;
  onIncludeArchivedChange: (includeArchived: boolean) => void;
  courses: Pick<Course, "id" | "name" | "code">[];
  searchScopeEnabled?: boolean;
  includeArchivedEnabled?: boolean;
  sortDisabled?: boolean;
  disabled?: boolean;
};

export default function FilesBrowserTools({
  query,
  onQueryChange,
  searchScope,
  onSearchScopeChange,
  courseFilter,
  onCourseFilterChange,
  fileType,
  onFileTypeChange,
  sortBy,
  onSortByChange,
  sortDirection,
  onSortDirectionChange,
  includeArchived,
  onIncludeArchivedChange,
  courses,
  searchScopeEnabled = true,
  includeArchivedEnabled = true,
  sortDisabled = false,
  disabled = false,
}: Props) {
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const focusSearch = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "k") return;
      if (disabled || document.activeElement?.closest("[role='dialog'], [aria-modal='true'], .files-action-sheet-backdrop")) return;
      if (searchInputRef.current?.closest("[hidden]")) return;
      event.preventDefault();
      searchInputRef.current?.focus();
    };
    document.addEventListener("keydown", focusSearch);
    return () => document.removeEventListener("keydown", focusSearch);
  }, [disabled]);

  return <section className="files-browser-tools" aria-label="Search and filter files">
    <div className="files-browser-search-row">
      <label className="files-browser-search">
        <span className="files-tools-sr-only">Search files</span>
        <span className="files-browser-search-control">
          <Search size={20} aria-hidden="true" />
          <input
            ref={searchInputRef}
            type="search"
            aria-label="Search files"
            placeholder="Search in Files..."
            value={query}
            onChange={(event) => onQueryChange(event.currentTarget.value)}
            disabled={disabled}
          />
          {query && <button type="button" aria-label="Clear search" disabled={disabled} onClick={() => onQueryChange("")}><X size={15} /></button>}
          <button type="button" className="files-browser-advanced-toggle" aria-label="Filters" title="Show advanced search and filter controls" aria-expanded={advancedOpen} aria-controls="files-browser-filter-controls" onClick={() => setAdvancedOpen((open) => !open)}>
            <SlidersHorizontal size={16} aria-hidden="true" /><span>Filters</span><span className="files-browser-filter-caret" aria-hidden="true">{advancedOpen ? "−" : "+"}</span>
          </button>
          <kbd className="files-search-shortcut">Ctrl K</kbd>
        </span>
      </label>
    </div>

    <div id="files-browser-filter-controls" className="files-browser-filter-controls" hidden={!advancedOpen}>
      {searchScopeEnabled && <label>
        <span>Search scope</span>
        <select aria-label="Search scope" value={searchScope} onChange={(event) => onSearchScopeChange(event.currentTarget.value as BrowserSearchScope)} disabled={disabled}>
          <option value="folder">Current folder</option>
          <option value="all">All active files</option>
        </select>
      </label>}

      <label>
        <span>Course filter</span>
        <select aria-label="Course filter" value={courseFilter} onChange={(event) => onCourseFilterChange(event.currentTarget.value)} disabled={disabled}>
          <option value="all">All courses</option>
          <option value="personal">Personal</option>
          {courses.map((course) => <option key={course.id} value={course.id}>{course.code ? `${course.code} · ${course.name}` : course.name}</option>)}
        </select>
      </label>

      <label>
        <span>File type</span>
        <select aria-label="File type" value={fileType} onChange={(event) => onFileTypeChange(event.currentTarget.value as BrowserFileType)} disabled={disabled}>
          <option value="all">All types</option>
          <option value="text">Text</option>
          <option value="pdf">PDF</option>
          <option value="image">Images</option>
          <option value="other">Other</option>
        </select>
      </label>

      <label>
        <span>Sort by</span>
        <select aria-label="Sort by" value={sortBy} onChange={(event) => onSortByChange(event.currentTarget.value as BrowserSortBy)} disabled={disabled || sortDisabled}>
          <option value="name">Name</option>
          <option value="modified">Last modified</option>
        </select>
      </label>

      <button
        className="files-browser-sort-direction"
        type="button"
        aria-label={`Sort ${sortDirection === "asc" ? "ascending" : "descending"}`}
        title={sortDirection === "asc" ? "Sort descending" : "Sort ascending"}
        disabled={disabled || sortDisabled}
        onClick={() => onSortDirectionChange(sortDirection === "asc" ? "desc" : "asc")}
      >
        {sortDirection === "asc" ? <ArrowUp size={15} aria-hidden="true" /> : <ArrowDown size={15} aria-hidden="true" />}
        <span>{sortDirection === "asc" ? "Ascending" : "Descending"}</span>
      </button>

      {includeArchivedEnabled && <label className="files-browser-include-archived">
        <input type="checkbox" aria-label="Include archived" checked={includeArchived} onChange={(event) => onIncludeArchivedChange(event.currentTarget.checked)} disabled={disabled} />
        <span>Include archived</span>
      </label>}
    </div>
  </section>;
}
