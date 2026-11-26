import type { BoardTheme } from '../shared/types';

export interface ThemePalette {
  id: BoardTheme;
  label: string;
  isDark: boolean;
  displayFontClass: string;
  pageBg: string;
  surfaceBg: string;
  surfaceElevated: string;
  borderColor: string;
  textPrimary: string;
  textMuted: string;
  accentBg: string;
  accentText: string;
  boardBg: string;
  boardGridStroke: string;
  boardFrameStroke: string;
  nodeFill: string;
  nodeHubFill: string;
  nodeStroke: string;
  nodeLabelBg: string;
  nodeLabelText: string;
  routeCasing: string;
  tunnelStroke: string;
}

export const BOARD_THEMES: Record<BoardTheme, ThemePalette> = {
  vintage: {
    id: 'vintage',
    label: 'Vintage Railway',
    isDark: false,
    displayFontClass: 'font-vintage',
    pageBg: 'bg-[#F4EFE6] text-[#2C241E]',
    surfaceBg: 'bg-[#EFE8DA]',
    surfaceElevated: 'bg-[#FAF7F0]',
    borderColor: 'border-[#D5C9B4]',
    textPrimary: 'text-[#2C241E]',
    textMuted: 'text-[#6B5D4D]',
    accentBg: 'bg-[#9B2C2C] hover:bg-[#7F2323] text-white',
    accentText: 'text-[#9B2C2C]',
    boardBg: '#F1E9D9',
    boardGridStroke: '#DFD3BD',
    boardFrameStroke: '#8C7355',
    nodeFill: '#FAF7F0',
    nodeHubFill: '#9B2C2C',
    nodeStroke: '#3D2E22',
    nodeLabelBg: 'rgba(250, 247, 240, 0.92)',
    nodeLabelText: '#2C241E',
    routeCasing: '#5C4B3B',
    tunnelStroke: '#3D2E22',
  },
  metro: {
    id: 'metro',
    label: 'Modern Metro',
    isDark: false,
    displayFontClass: 'font-metro',
    pageBg: 'bg-[#F8FAFC] text-[#0F172A]',
    surfaceBg: 'bg-[#F1F5F9]',
    surfaceElevated: 'bg-white',
    borderColor: 'border-[#CBD5E1]',
    textPrimary: 'text-[#0F172A]',
    textMuted: 'text-[#475569]',
    accentBg: 'bg-[#1D4ED8] hover:bg-[#1E40AF] text-white',
    accentText: 'text-[#1D4ED8]',
    boardBg: '#FFFFFF',
    boardGridStroke: '#E2E8F0',
    boardFrameStroke: '#94A3B8',
    nodeFill: '#FFFFFF',
    nodeHubFill: '#1D4ED8',
    nodeStroke: '#0F172A',
    nodeLabelBg: 'rgba(255, 255, 255, 0.94)',
    nodeLabelText: '#0F172A',
    routeCasing: '#334155',
    tunnelStroke: '#0F172A',
  },
  dark: {
    id: 'dark',
    label: 'Tactical Dark',
    isDark: true,
    displayFontClass: 'font-metro',
    pageBg: 'bg-[#0F172A] text-[#F1F5F9]',
    surfaceBg: 'bg-[#162033]',
    surfaceElevated: 'bg-[#1E293B]',
    borderColor: 'border-[#334155]',
    textPrimary: 'text-[#F8FAFC]',
    textMuted: 'text-[#94A3B8]',
    accentBg: 'bg-[#D97706] hover:bg-[#B45309] text-slate-950 font-semibold',
    accentText: 'text-[#F59E0B]',
    boardBg: '#0B1220',
    boardGridStroke: '#1E293B',
    boardFrameStroke: '#475569',
    nodeFill: '#1E293B',
    nodeHubFill: '#F59E0B',
    nodeStroke: '#E2E8F0',
    nodeLabelBg: 'rgba(15, 23, 42, 0.9)',
    nodeLabelText: '#F8FAFC',
    routeCasing: '#475569',
    tunnelStroke: '#CBD5E1',
  },
};
