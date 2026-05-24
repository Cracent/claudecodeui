import { useCallback, useEffect, useRef, useState } from 'react';
import { Send, Square, Paperclip, Slash, Folder, File, CornerLeftUp } from 'lucide-react';
import { authenticatedFetch } from '../../../../utils/api';
import type { Project } from '../../../../types/app';

type Skill = {
  name: string;
  description: string;
  command: string;
};

type FileTreeNode = {
  name: string;
  path: string;
  type: 'file' | 'directory';
  children?: FileTreeNode[];
};

type ShellInputBarProps = {
  selectedProject: Project | null | undefined;
  sendInput: (data: string) => void;
  isConnected: boolean;
};

export default function ShellInputBar({ selectedProject, sendInput, isConnected }: ShellInputBarProps) {
  const [text, setText] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const [slashMenuOpen, setSlashMenuOpen] = useState(false);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [skillsLoaded, setSkillsLoaded] = useState(false);
  const [filePickerOpen, setFilePickerOpen] = useState(false);
  const [allFileItems, setAllFileItems] = useState<FileTreeNode[]>([]);
  const [currentDir, setCurrentDir] = useState('');
  const [filesLoaded, setFilesLoaded] = useState(false);
  const [focused, setFocused] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const slashBtnRef = useRef<HTMLButtonElement>(null);
  const slashMenuRef = useRef<HTMLDivElement>(null);
  const fileBtnRef = useRef<HTMLButtonElement>(null);
  const fileMenuRef = useRef<HTMLDivElement>(null);
  const lastSentTextRef = useRef('');
  const clearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const streamingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const insertAtCursor = useCallback((insertText: string) => {
    const ta = textareaRef.current;
    if (!ta) return;
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    const before = text.substring(0, start);
    const after = text.substring(end);
    const newText = before + insertText + ' ' + after;
    setText(newText);
    requestAnimationFrame(() => {
      ta.selectionStart = ta.selectionEnd = start + insertText.length + 1;
      ta.focus();
    });
  }, [text]);

  const adjustHeight = useCallback(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 160) + 'px';
  }, []);

  useEffect(() => {
    adjustHeight();
  }, [text, adjustHeight]);

  // Normalize path separators to forward slashes for consistent comparison
  const norm = useCallback((p: string) => p.replace(/\\/g, '/'), []);

  // Compute relative path by stripping project root prefix
  const getRelativePath = useCallback((absPath: string) => {
    const root = norm(selectedProject?.path || '');
    const normalized = norm(absPath);
    if (root && normalized.startsWith(root)) {
      let rel = normalized.slice(root.length);
      if (rel.startsWith('/')) rel = rel.slice(1);
      return rel;
    }
    return normalized;
  }, [selectedProject?.path, norm]);

  const loadSkills = useCallback(async () => {
    if (skillsLoaded || !selectedProject?.path) return;
    try {
      const res = await authenticatedFetch(
        `/api/providers/claude/skills?workspacePath=${encodeURIComponent(selectedProject.path)}`
      );
      if (res.ok) {
        const data = await res.json();
        setSkills(data.data?.skills || []);
      }
    } catch { /* ignore */ }
    setSkillsLoaded(true);
  }, [skillsLoaded, selectedProject?.path]);

  // Extract parent path from a file/directory path (normalized to forward slashes)
  const getParentDir = useCallback((p: string) => {
    const normalized = norm(p);
    const idx = normalized.lastIndexOf('/');
    return idx > 0 ? normalized.substring(0, idx) : '';
  }, [norm]);

  const flattenAll = useCallback((nodes: FileTreeNode[]): FileTreeNode[] => {
    const result: FileTreeNode[] = [];
    const walk = (items: FileTreeNode[]) => {
      for (const node of items) {
        result.push(node);
        if (node.children && node.children.length > 0) walk(node.children);
      }
    };
    walk(nodes);
    return result;
  }, []);

  const loadFiles = useCallback(async () => {
    if (filesLoaded || !selectedProject?.projectId) return;
    try {
      const res = await authenticatedFetch(`/api/projects/${selectedProject.projectId}/files`);
      if (res.ok) {
        const tree = await res.json();
        const nodes = Array.isArray(tree) ? tree : [];
        setAllFileItems(flattenAll(nodes));
      }
    } catch { /* ignore */ }
    setFilesLoaded(true);
  }, [filesLoaded, selectedProject?.projectId, flattenAll]);

  // Current directory items filtered by parent path (all paths normalized)
  const currentItems = allFileItems.filter((item) => {
    const parent = getParentDir(item.path);
    if (currentDir === '') {
      const root = norm(selectedProject?.path || '');
      return parent === root;
    }
    return parent === currentDir;
  });

  // Directories first, alphabetical within each type
  const sortedItems = [...currentItems].sort((a, b) => {
    if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  useEffect(() => {
    if (!slashMenuOpen && !filePickerOpen) return;
    const handler = (e: MouseEvent) => {
      if (slashMenuOpen && slashMenuRef.current && !slashMenuRef.current.contains(e.target as Node) &&
          slashBtnRef.current && !slashBtnRef.current.contains(e.target as Node)) {
        setSlashMenuOpen(false);
      }
      if (filePickerOpen && fileMenuRef.current && !fileMenuRef.current.contains(e.target as Node) &&
          fileBtnRef.current && !fileBtnRef.current.contains(e.target as Node)) {
        setFilePickerOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [slashMenuOpen, filePickerOpen]);

  // Reset navigation when file picker closes
  useEffect(() => {
    if (!filePickerOpen) setCurrentDir('');
  }, [filePickerOpen]);

  const handleSend = () => {
    const trimmed = text.trim();
    if (!trimmed) return;
    lastSentTextRef.current = text;
    sendInput(trimmed + '\r');
    setText('');
    setIsStreaming(true);
    if (textareaRef.current) textareaRef.current.style.height = 'auto';
  };

  const handleStop = () => {
    if (clearTimerRef.current) {
      clearTimeout(clearTimerRef.current);
      clearTimerRef.current = null;
    }
    if (streamingTimerRef.current) {
      clearTimeout(streamingTimerRef.current);
      streamingTimerRef.current = null;
    }
    sendInput('\x03');
    setIsStreaming(false);
    if (lastSentTextRef.current) {
      setText(lastSentTextRef.current);
    }
    clearTimerRef.current = setTimeout(() => {
      sendInput('\x15');
      clearTimerRef.current = null;
    }, 1500);
  };

  const handleSlashSelect = (skill: Skill) => {
    setSlashMenuOpen(false);
    insertAtCursor(skill.command);
  };

  const handleFileSelect = (file: FileTreeNode) => {
    setFilePickerOpen(false);
    insertAtCursor('@' + getRelativePath(file.path));
  };

  const handleDirEnter = (dir: FileTreeNode) => {
    setCurrentDir(norm(dir.path));
  };

  const handleDirUp = () => {
    setCurrentDir((prev) => getParentDir(prev));
  };

  const canSend = text.trim().length > 0 && isConnected;

  return (
    <div className="relative border-t border-border bg-gray-900 px-2 py-1.5 md:hidden">
      {/* Slash skills popup */}
      {slashMenuOpen && (
        <div
          ref={slashMenuRef}
          className="absolute bottom-full left-2 mb-1 w-72 rounded-lg border border-border bg-gray-800 shadow-lg z-50"
        >
          <div className="px-3 py-1.5 text-xs text-muted-foreground border-b border-border">Skills</div>
          <div className="max-h-56 overflow-y-auto py-1">
            {skills.length === 0 ? (
              <div className="px-3 py-4 text-xs text-muted-foreground text-center">
                {skillsLoaded ? 'No skills found' : 'Loading...'}
              </div>
            ) : (
              skills.map((skill) => (
                <button
                  key={skill.name}
                  onClick={(e) => { e.preventDefault(); handleSlashSelect(skill); }}
                  className="w-full flex flex-col items-start px-3 py-2 text-left text-sm
                             hover:bg-gray-700 transition-colors border-b border-border/50 last:border-b-0"
                >
                  <span className="font-mono font-semibold text-blue-400 text-xs">
                    {skill.command}
                  </span>
                  <span className="text-xs text-muted-foreground mt-0.5 line-clamp-2">{skill.description}</span>
                </button>
              ))
            )}
          </div>
        </div>
      )}

      {/* File picker popup */}
      {filePickerOpen && (
        <div
          ref={fileMenuRef}
          className="absolute bottom-full left-2 mb-1 w-72 rounded-lg border border-border bg-gray-800 shadow-lg z-50"
        >
          <div className="px-3 py-1.5 text-xs text-muted-foreground border-b border-border flex items-center gap-2">
            <span className="flex-1 truncate">
              {currentDir === '' ? 'Select file' : getRelativePath(currentDir)}
            </span>
          </div>
          <div className="max-h-56 overflow-y-auto py-1">
            {!filesLoaded ? (
              <div className="px-3 py-4 text-xs text-muted-foreground text-center">Loading...</div>
            ) : sortedItems.length === 0 && currentDir === '' ? (
              <div className="px-3 py-4 text-xs text-muted-foreground text-center">No files found</div>
            ) : (
              <>
                {/* Back navigation */}
                {currentDir !== '' && (
                  <button
                    onClick={(e) => { e.preventDefault(); handleDirUp(); }}
                    className="w-full flex items-center gap-2 text-left px-3 py-1.5 text-xs
                               text-blue-400 hover:bg-gray-700 transition-colors
                               border-b border-border/30"
                  >
                    <CornerLeftUp size={14} />
                    <span>..</span>
                  </button>
                )}
                {sortedItems.map((item) => (
                  <button
                    key={item.path}
                    onClick={(e) => {
                      e.preventDefault();
                      if (item.type === 'directory') handleDirEnter(item);
                      else handleFileSelect(item);
                    }}
                    className="w-full flex items-center gap-2 text-left px-3 py-1.5 text-xs
                               hover:bg-gray-700 transition-colors border-b border-border/30 last:border-b-0"
                  >
                    {item.type === 'directory' ? (
                      <Folder size={14} className="text-yellow-500 flex-shrink-0" />
                    ) : (
                      <File size={14} className="text-muted-foreground flex-shrink-0" />
                    )}
                    <span className="truncate">{item.name}</span>
                  </button>
                ))}
              </>
            )}
          </div>
        </div>
      )}

      {/* Input row */}
      <div className="flex items-stretch gap-1.5">
        {/* Tool buttons */}
        <div className="flex flex-col gap-0.5 flex-shrink-0 justify-center">
          <button
            ref={slashBtnRef}
            onClick={() => {
              if (!slashMenuOpen) loadSkills();
              setSlashMenuOpen((prev) => !prev);
              setFilePickerOpen(false);
            }}
            className="w-5 h-5 flex items-center justify-center rounded text-muted-foreground
                       hover:text-blue-400 transition-colors"
            aria-label="Commands"
          >
            <Slash size={13} />
          </button>
          <button
            ref={fileBtnRef}
            onClick={() => {
              if (!filePickerOpen) loadFiles();
              setFilePickerOpen((prev) => !prev);
              setSlashMenuOpen(false);
            }}
            className="w-5 h-5 flex items-center justify-center rounded text-muted-foreground
                       hover:text-blue-400 transition-colors"
            aria-label="Attach file"
          >
            <Paperclip size={12} />
          </button>
        </div>

        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onInput={adjustHeight}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          rows={1}
          placeholder="Type a message... (/ commands, @ files)"
          disabled={!isConnected}
          className="flex-1 resize-none bg-transparent text-sm text-foreground
                     placeholder:text-muted-foreground py-1.5 px-0
                     disabled:opacity-50 self-center"
          style={{ maxHeight: 160 }}
        />

        {/* Send / Stop */}
        <div className="flex-shrink-0 flex items-center">
          {isStreaming ? (
            <button
              onClick={handleStop}
              disabled={!isConnected}
              className="w-8 h-8 flex items-center justify-center rounded-full
                         bg-red-600/20 text-red-400 hover:bg-red-600/30 transition-colors
                         disabled:opacity-40 disabled:cursor-not-allowed"
              aria-label="Stop"
            >
              <Square size={14} fill="currentColor" />
            </button>
          ) : (
            <button
              onClick={handleSend}
              disabled={!canSend}
              className={`w-8 h-8 flex items-center justify-center rounded-full transition-colors ${
                canSend
                  ? 'bg-blue-600 text-white hover:bg-blue-500 shadow-sm'
                  : 'bg-gray-700 text-muted-foreground cursor-not-allowed'
              }`}
              aria-label="Send"
            >
              <Send size={14} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
