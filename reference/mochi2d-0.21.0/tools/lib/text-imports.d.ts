// Text files bundled as strings by the tools build (esbuild's "text" loader).
declare module "*.md" {
  const text: string;
  export default text;
}
declare module "*.txt" {
  const text: string;
  export default text;
}
