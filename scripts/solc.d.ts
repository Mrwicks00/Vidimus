declare module "solc" {
  function compile(input: string): string;
  const solc: { compile: typeof compile };
  export default solc;
}
