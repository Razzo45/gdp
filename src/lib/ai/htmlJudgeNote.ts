/** Grader instruction for HTML deliverables: screenshot first, source only as support. */
export function htmlVisualJudgeNote(input: { hasScreenshots: boolean; views?: string }): string {
  if (!input.hasScreenshots) {
    return 'The page could not be rendered in a browser, so there is no screenshot. Answer visual, canvas, WebGL, three.js, animation, and gameplay statements No. Source may be used only for non-visual file or format statements that the markup states explicitly.';
  }
  return `The page was opened in a browser and screenshotted (${input.views ?? 'desktop and phone'}). Judge from the screenshots first. Anything a human would see — layout, colour, typography, HUD, canvas, WebGL, three.js, character, environment — is Yes only if it is visible in a screenshot. Source code may reinforce a Yes the screenshot already supports, or explain a No; it cannot turn a missing or broken visual into a Yes. States reached only by clicking, hovering, or later animation are not in these screenshots: answer those No unless a screenshot already shows that state.`;
}
