import { getNodeValue, Node, parseTree, ParseError, ParseOptions } from 'jsonc-parser';

export const defaultParseOptions: ParseOptions = {
  allowTrailingComma: true,
  disallowComments: false
};

export interface JsonAnalysisResult {
  errors: ParseError[];
  root: Node | undefined;
  data: unknown;
}

export function analyzeJsonText(text: string, options: ParseOptions = defaultParseOptions): JsonAnalysisResult {
  const errors: ParseError[] = [];
  const root = parseTree(text, errors, options);
  const data = root ? getNodeValue(root) : undefined;
  return { errors, root, data };
}
