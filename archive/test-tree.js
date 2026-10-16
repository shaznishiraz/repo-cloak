import { checkboxTreeSelect } from './src/ui/treeCheckboxSelector.js';
checkboxTreeSelect({ root: process.cwd(), maxDepth: 1 }).then(res => console.log(res));
