// The wordmark, in ANSI Shadow. Two-tone: solid blocks in the terminal's own foreground, the shadow in gray,
// so it has depth and stays monochrome. The only color is the legend, where it means what it means everywhere
// in gutfeel: the state a walk ended in. Plain text when the output isn't a terminal or NO_COLOR is set.
const WORD = [
  ' ██████╗ ██╗   ██╗████████╗███████╗███████╗███████╗██╗     ',
  '██╔════╝ ██║   ██║╚══██╔══╝██╔════╝██╔════╝██╔════╝██║     ',
  '██║  ███╗██║   ██║   ██║   █████╗  █████╗  █████╗  ██║     ',
  '██║   ██║██║   ██║   ██║   ██╔══╝  ██╔══╝  ██╔══╝  ██║     ',
  '╚██████╔╝╚██████╔╝   ██║   ██║     ███████╗███████╗███████╗',
  ' ╚═════╝  ╚═════╝    ╚═╝   ╚═╝     ╚══════╝╚══════╝╚══════╝',
];

export function banner(version: string): string {
  const color = process.stdout.isTTY && !process.env.NO_COLOR;
  const c = (code: string, s: string) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
  const word = WORD.map((l) => '  ' + [...l].map((ch) => (ch === '█' ? c('1', ch) : ch === ' ' ? ch : c('90', ch))).join('')).join('\n');
  const legend = [c('32', '●') + ' reached', c('31', '✕') + ' wrong turn', c('33', '⊣') + ' dead end', c('90', '‖') + ' stalled'].join('   ');
  return `\n${word}\n\n  ${c('1', 'usability testing for MCP servers')} ${c('90', `· v${version}`)}\n  ${legend}\n`;
}
