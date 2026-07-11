// `import x from '...?raw'` -> the file's contents as a string (webpack asset/source).
declare module '*?raw' {
    const content: string;
    export default content;
}
