import { Ionicons } from '@expo/vector-icons';
import { useFonts } from 'expo-font';

// Bundle fonts in the native binary: do not depend on a CDN at cold start.
export const useIconFonts = (): readonly [boolean, Error | null] =>
  useFonts(Ionicons.font);
