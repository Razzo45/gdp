/** Named craft implicits. Not an open “a designer would…” list. */
export const HELPER_CRAFT = {
  'slides-canvas': 'On-screen objects stay inside the slide canvas.',
  'slides-title-safe': 'Required titles stay inside title-safe margins.',
  'logo-undistorted': 'The logo keeps its aspect ratio.',
  'live-text': 'Print or deck type stays as live text, not outlines, unless the brief says otherwise.',
  'video-sync': 'On-camera speech stays in sync with the mouth.',
} as const;

export type HelperCraftId = keyof typeof HELPER_CRAFT;
