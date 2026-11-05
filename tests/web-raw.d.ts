// Raw-source imports for the UI lock tests: the SPA sources are asserted as
// shipped text because the workerd test pool has no DOM to mount them in.
declare module "*.html?raw" {
  const html: string;
  export default html;
}
declare module "*.ts?raw" {
  const source: string;
  export default source;
}
declare module "*.css?raw" {
  const css: string;
  export default css;
}
declare module "*.js?raw" {
  const source: string;
  export default source;
}
