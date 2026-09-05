import { useState, useCallback, KeyboardEvent, useEffect, useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { Archive, Book, Brain, Briefcase, Calendar, Code, FileText, Folder, FolderKanban, Heart, Home, Lightbulb, Pin, Rocket, Search, Settings, Star, User, X, type LucideIcon } from "lucide-react";

export type IconName = 
  | "folder" | "star" | "code" | "work" | "personal" | "ideas" 
  | "projects" | "archive" | "book" | "notes" | "brain" | "rocket" 
  | "heart" | "home" | "settings" | "calendar" | "search" | "pin";

export const FOLDER_ICONS: { name: IconName; label: string; icon: LucideIcon }[] = [
  { name: "folder", label: "Folder", icon: Folder },
  { name: "star", label: "Star", icon: Star },
  { name: "code", label: "Code", icon: Code },
  { name: "work", label: "Work", icon: Briefcase },
  { name: "personal", label: "Personal", icon: User },
  { name: "ideas", label: "Ideas", icon: Lightbulb },
  { name: "projects", label: "Projects", icon: FolderKanban },
  { name: "archive", label: "Archive", icon: Archive },
  { name: "book", label: "Book", icon: Book },
  { name: "notes", label: "Notes", icon: FileText },
  { name: "brain", label: "AI", icon: Brain },
  { name: "rocket", label: "Rocket", icon: Rocket },
  { name: "heart", label: "Heart", icon: Heart },
  { name: "home", label: "Home", icon: Home },
  { name: "settings", label: "Settings", icon: Settings },
  { name: "calendar", label: "Calendar", icon: Calendar },
  { name: "search", label: "Search", icon: Search },
  { name: "pin", label: "Pinned", icon: Pin },
];

interface IconPickerProps {
  isOpen: boolean;
  onClose: () => void;
  onSelect: (iconName: IconName) => void;
  selectedIcon?: IconName;
  anchorX: number;
  anchorY: number;
}

export function IconPicker({ isOpen, onClose, onSelect, selectedIcon, anchorX, anchorY }: IconPickerProps) {
  const [focusedIndex, setFocusedIndex] = useState(0);
  const [position, setPosition] = useState({ left: anchorX, top: anchorY });
  const pickerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isOpen) return;
    const selectedIndex = FOLDER_ICONS.findIndex((item) => item.name === selectedIcon);
    setFocusedIndex(selectedIndex >= 0 ? selectedIndex : 0);
    pickerRef.current?.focus();
  }, [isOpen, selectedIcon]);

  useEffect(() => {
    if (!isOpen) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (!pickerRef.current?.contains(event.target as Node)) onClose();
    };
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [isOpen, onClose]);

  useLayoutEffect(() => {
    if (!isOpen || !pickerRef.current) return;
    const margin = 8;
    const picker = pickerRef.current;
    const left = Math.max(margin, Math.min(anchorX, window.innerWidth - picker.offsetWidth - margin));
    const top = Math.max(margin, Math.min(anchorY, window.innerHeight - picker.offsetHeight - margin));
    setPosition({ left, top });
  }, [anchorX, anchorY, isOpen]);

  const handleKeyDown = useCallback((event: KeyboardEvent) => {
    if (event.key === "Escape") {
      onClose();
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setFocusedIndex((prev) => (prev + 1) % FOLDER_ICONS.length);
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setFocusedIndex((prev) => (prev - 1 + FOLDER_ICONS.length) % FOLDER_ICONS.length);
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onSelect(FOLDER_ICONS[focusedIndex].name);
      onClose();
    }
  }, [focusedIndex, onClose, onSelect]);

  if (!isOpen) return null;

  const IconGrid = () => (
    <div
      ref={pickerRef}
      className="icon-picker"
      role="dialog"
      aria-label="Choose folder icon"
      onKeyDown={handleKeyDown}
      tabIndex={-1}
      style={{
        position: "fixed",
        left: position.left,
        top: position.top,
        zIndex: 1000,
      }}
    >
      <div className="icon-picker-header">
        <span>Choose icon</span>
        <button 
          type="button" 
          className="icon-picker-close" 
          onClick={onClose}
          aria-label="Close"
        >
          <X size={16} strokeWidth={1.5} />
        </button>
      </div>
      <div className="icon-picker-grid">
        {FOLDER_ICONS.map((item, index) => {
          const IconComponent = item.icon;
          return (
            <button
              key={item.name}
              type="button"
              className={`icon-picker-item ${selectedIcon === item.name ? "selected" : ""}`}
              onClick={() => {
                onSelect(item.name);
                onClose();
              }}
              aria-label={item.label}
              aria-pressed={selectedIcon === item.name}
              tabIndex={index === focusedIndex ? 0 : -1}
              onFocus={() => setFocusedIndex(index)}
            >
              <IconComponent size={20} strokeWidth={1.5} />
              <span className="icon-picker-label">{item.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );

  return createPortal(<IconGrid />, document.body);
}