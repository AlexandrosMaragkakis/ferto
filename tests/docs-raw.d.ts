// Raw-source imports for the documentation lock tests: files are asserted as
// shipped text because the workerd test pool has no filesystem to read them.
declare module "*.md?raw" {
  const markdown: string;
  export default markdown;
}
declare module "*.puml?raw" {
  const plantuml: string;
  export default plantuml;
}
declare module "*.json?raw" {
  const json: string;
  export default json;
}
declare module "*.example?raw" {
  const example: string;
  export default example;
}
