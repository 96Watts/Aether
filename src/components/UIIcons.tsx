import { 
  MessageSquarePlus, FolderPlus, Edit2, Trash2, Move, 
  Download, Upload, Paperclip, Settings, Search, Pin, Copy, Share2,
  RotateCcw, ThumbsUp, ThumbsDown, Pencil, Check,
  ChevronRight, ChevronDown, Sparkles, Star, Server, Cloud,
  Cpu, HardDrive, Menu, Plus, X as Close, Archive
} from "lucide-react";

// UI Icons with consistent styling
export const UIIcons = {
  // Conversation actions
  newConversation: MessageSquarePlus,
  newFolder: FolderPlus,
  rename: Edit2,
  delete: Trash2,
  move: Move,
  archive: Archive,
  pin: Pin,
  
  // Import/Export
  import: Download,
  export: Upload,
  attachments: Paperclip,
  copy: Copy,
  share: Share2,
  retry: RotateCcw,
  positive: ThumbsUp,
  negative: ThumbsDown,
  edit: Pencil,
  check: Check,
  
  // Navigation
  menu: Menu,
  close: Close,
  settings: Settings,
  search: Search,
  
  // Expand/Collapse
  expand: ChevronRight,
  collapse: ChevronDown,
  
  // Model status
  localModel: Server,
  apiModel: Cloud,
  cpu: Cpu,
  storage: HardDrive,
  
  // Branding
  brand: Sparkles,
  thinking: Star,
  plus: Plus,
};