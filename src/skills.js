// What Resume insights looks for in postings and resumes: skills and tools, each with
// the other ways people write it, and the kinds of role a job title describes.
// Words that are also ordinary English ("go", "spring", "express", "r") are only matched
// in forms that can't be anything else ("golang", "spring boot", "express.js").

// [name shown, ...other spellings]. Matching ignores case. A name starting with "!" is
// only matched by its other spellings, because the name itself is an everyday word.
// A spelling starting with "~" is also an everyday word, but one people write as a skill
// often enough to keep: it only counts written exactly so ("Swift", not "swift") and where
// a skill would sit, such as in a list or before "developer", not before an ordinary word
// ("Swift response", "Security clearance", "Spark joy").
const SKILL_LIST = [
  // Languages
  ['Python'], ['Java'], ['JavaScript', 'js', 'ecmascript'], ['TypeScript'], ['C++', 'cpp'], ['C#', 'csharp'],
  ['!Go', 'golang'], ['~Rust'], ['~Ruby'], ['PHP'], ['~Swift'], ['Kotlin'], ['Scala'], ['Objective-C'], ['~Dart'],
  ['Elixir'], ['Haskell'], ['Perl'], ['Lua'], ['MATLAB'], ['!Julia', 'julia language'], ['Bash', 'shell scripting'], ['PowerShell'],
  ['SQL'], ['HTML', 'html5'], ['CSS', 'css3'], ['Sass', 'scss'], ['Solidity'], ['Verilog'], ['VHDL'], ['!Assembly', 'assembly language', 'x86 assembly', 'arm assembly'],
  ['!R programming', 'rstudio', 'r programming'],
  // Frontend
  ['React', 'react.js', 'reactjs'], ['React Native'], ['Next.js', 'nextjs'], ['Vue', 'vue.js', 'vuejs'], ['Nuxt'],
  ['Angular', 'angularjs'], ['Svelte', 'sveltekit'], ['Redux'], ['Tailwind', 'tailwind css', 'tailwindcss'],
  ['Webpack'], ['Vite'], ['jQuery'], ['D3', 'd3.js'], ['Three.js', 'threejs'], ['WebGL'], ['~Accessibility', 'a11y', 'wcag'],
  ['Responsive design'], ['Figma'], ['Storybook'],
  // Backend and APIs
  ['Node.js', 'nodejs'], ['Express.js', 'expressjs'], ['NestJS'], ['Django'], ['Flask'], ['FastAPI'],
  ['Spring Boot', 'spring framework'], ['Ruby on Rails', '~Rails'], ['Laravel'], ['.NET', 'dotnet', 'asp.net'],
  ['GraphQL'], ['REST APIs', 'rest api', 'restful'], ['gRPC'], ['Microservices', 'microservice'],
  ['WebSockets', 'websocket'], ['OAuth'], ['Event-driven architecture', 'event driven'],
  // Data stores
  ['PostgreSQL', 'postgres'], ['MySQL'], ['SQLite'], ['MongoDB', 'mongo'], ['Redis'], ['Cassandra'], ['DynamoDB'],
  ['Elasticsearch', 'opensearch'], ['~Snowflake'], ['BigQuery'], ['Redshift'], ['SQL Server', 'mssql'],
  ['Firebase'], ['Supabase'], ['Neo4j'],
  // Cloud and infrastructure
  ['AWS', 'amazon web services'], ['GCP', 'google cloud', 'google cloud platform'], ['Azure', 'microsoft azure'],
  ['Docker'], ['Kubernetes', 'k8s'], ['Terraform'], ['Ansible'], ['~Helm'], ['Linux', 'unix'],
  ['CI/CD', 'ci cd', 'continuous integration', 'continuous delivery'], ['GitHub Actions'], ['Jenkins'], ['GitLab CI'],
  ['Git', 'github', 'gitlab'], ['Serverless', 'aws lambda', 'lambda functions'], ['Nginx'], ['Prometheus'], ['Grafana'],
  ['Datadog'], ['Observability', '~Monitoring'], ['!Networking', 'computer networking', 'network protocols', 'tcp/ip'], ['Distributed systems'], ['System design'],
  ['Scalability'], ['High availability'], ['Site reliability', 'sre'], ['DevOps'], ['Infrastructure as code', 'iac'],
  // Data and analytics
  ['Pandas'], ['NumPy'], ['Apache Spark', '~Spark', 'pyspark'], ['Hadoop'], ['Kafka', 'apache kafka'], ['Airflow', 'apache airflow'],
  ['dbt'], ['ETL', 'elt', 'data pipelines', 'data pipeline'], ['Data modeling', 'data modelling'], ['Data warehousing', 'data warehouse'],
  ['Tableau'], ['Power BI', 'powerbi'], ['~Looker'], ['!Excel', 'microsoft excel', 'ms excel', 'excel spreadsheets', 'advanced excel'], ['Statistics', 'statistical analysis'],
  ['A/B testing', 'ab testing', 'experimentation'], ['Data visualization', 'data visualisation'], ['Jupyter'],
  ['Databricks'],
  // Machine learning and AI
  ['Machine learning', 'ml'], ['Deep learning'], ['PyTorch'], ['TensorFlow'], ['Keras'], ['scikit-learn', 'sklearn'],
  ['NLP', 'natural language processing'], ['Computer vision', 'opencv'], ['LLMs', 'llm', 'large language models', 'large language model'],
  ['Generative AI', 'genai', 'gen ai'], ['~RAG', 'retrieval augmented generation', 'retrieval-augmented generation'],
  ['Reinforcement learning'], ['XGBoost'], ['Hugging Face', 'huggingface', '~Transformers'], ['MLOps'], ['CUDA'],
  ['Recommender systems', 'recommendation systems'], ['Time series'], ['Prompt engineering'],
  // Mobile
  ['iOS'], ['Android'], ['SwiftUI'], ['Jetpack Compose'], ['Flutter'], ['Xcode'],
  // Testing and quality
  ['Unit testing', 'unit tests'], ['Test automation', 'automated testing'], ['~Jest'], ['Pytest'], ['JUnit'],
  ['Cypress'], ['Playwright'], ['Selenium'], ['TDD', 'test-driven development', 'test driven development'],
  ['Code review', 'code reviews'], ['Debugging'], ['Performance optimization', 'performance tuning'],
  // Fundamentals and practice
  ['Data structures'], ['Algorithms'], ['Object-oriented programming', 'oop', 'object oriented'], ['Functional programming'],
  ['Concurrency', 'multithreading', 'multi-threading'], ['Operating systems'], ['Compilers'], ['Agile', 'scrum'],
  ['Jira'], ['API design'], ['~Security', 'application security', 'appsec'], ['Cryptography'], ['Penetration testing', 'pentesting'],
  // Embedded and hardware
  ['Embedded systems', 'embedded c', 'embedded software'], ['Firmware'], ['RTOS'], ['Microcontrollers', 'arduino', 'stm32'],
  ['~ROS', 'robot operating system'], ['FPGA'], ['PCB design'], ['Raspberry Pi'],
  // Games and graphics
  ['~Unity', 'unity3d'], ['Unreal Engine', '~Unreal'], ['OpenGL'], ['Vulkan'], ['Game development', 'game dev'],
  // Finance and quant
  ['Quantitative analysis', 'quantitative research'], ['Financial modeling', 'financial modelling'], ['Trading systems'],
  ['Risk modeling', 'risk modelling'],
  // Product and design
  ['Product management'], ['User research', 'ux research'], ['Wireframing', 'wireframes'], ['Prototyping'], ['UX design', 'ux'],
  ['UI design'],
];

const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
// A match can't run into letters or digits on either side, so "java" isn't found in
// "javascript". "+", "#" and "." count as part of the word, so "c++" and ".net" work.
const BEFORE = '(?<![\\w+#.])';
const AFTER = '(?![\\w+#])';
// Where an everyday-word spelling counts: the end of the text or a line, punctuation that
// separates a list, "and"/"or", a word that says it's a skill, or a capitalised word (a
// list written with spaces, or a job title like "Security Engineer").
const SKILL_CONTEXT = '(?=$|\\s*[\\n,;:/|)\\]•·!?&+]|\\.(?!\\w)|\\s+(?:and|or|developers?|engineers?|engineering|development|programming|code|apps?|frameworks?|projects?|experience|skills?|stack)\\b|\\s+[A-Z0-9(])';

export const SKILLS = SKILL_LIST.map(([name, ...aliases]) => {
  const aliasOnly = name.startsWith('!');
  const spellings = aliasOnly ? aliases : [name, ...aliases];
  name = name.replace(/^[!~]/, '');
  const plain = spellings.filter(w => !w.startsWith('~')).map(w => escapeRe(w.toLowerCase()));
  const exact = spellings.filter(w => w.startsWith('~')).map(w => escapeRe(w.slice(1)));
  const res = [
    plain.length && new RegExp(`${BEFORE}(?:${plain.join('|')})${AFTER}`, 'gi'),
    exact.length && new RegExp(`${BEFORE}(?:${exact.join('|')})${AFTER}${SKILL_CONTEXT}`, 'g'),
  ].filter(Boolean);
  return { name, res };
});

// Links and email addresses say nothing about skills ("github.com/sam" isn't Git).
const LINKS = /\bhttps?:\/\/\S+|\bwww\.\S+|\S+@\S+|\b[\w-]+\.(?:com|io|dev|org|me|app|co|edu)\b\S*/gi;

// Every skill named somewhere in the text, by its display name. A skill only named inside
// a longer one ("React" in "React Native", "Ruby" in "Ruby on Rails") doesn't count.
export function findSkills(text) {
  const found = new Set();
  if (!text) return found;
  const clean = String(text).replace(LINKS, ' ');
  const spans = [];
  for (const s of SKILLS) {
    for (const re of s.res) for (const m of clean.matchAll(re)) spans.push({ name: s.name, start: m.index, end: m.index + m[0].length });
  }
  for (const a of spans) {
    const inside = spans.some(b => b.name !== a.name && b.start <= a.start && b.end >= a.end && b.end - b.start > a.end - a.start);
    if (!inside) found.add(a.name);
  }
  return found;
}

// ---- role types -------------------------------------------------------------------
// What kind of work a job title describes, and at what level. The first match wins, so
// the more specific kinds come first ("Data Engineer" is Data, not general Software).
const FUNCTIONS = [
  ['Machine learning', /\b(machine learning|ml|ai|artificial intelligence|deep learning|nlp|computer vision)\b/i],
  ['Quant and trading', /\b(quant|quantitative|trader|trading)\b/i],
  // A data center is infrastructure, not data work.
  ['Data', /\b(data(?!\s+cent(?:er|re))|analytics|analyst|business intelligence|bi)\b/i],
  ['Mobile', /\b(mobile|ios|android)\b/i],
  ['Frontend', /\b(front[- ]?end|ui engineer|web developer|web engineer)\b/i],
  ['Full stack', /\b(full[- ]?stack)\b/i],
  // "Server" alone is as often a restaurant job as a backend one.
  ['Backend', /\b(back[- ]?end|server[- ]side|api)\b/i],
  ['Infrastructure', /\b(platform|infrastructure|cloud|site reliability|sre|devops|systems engineer|data cent(?:er|re))\b/i],
  ['Embedded and robotics', /\b(embedded|firmware|robotics|hardware)\b/i],
  ['Security', /\b(security|cyber)\b/i],
  ['Games', /\b(game|games|gameplay)\b/i],
  ['Research', /\b(research)\b/i],
  ['Product and design', /\b(product manager|product designer|designer|ux|ui\/ux)\b/i],
];
const LEVELS = [
  ['Internship', /\b(intern|internship|co-?op|placement|summer)\b/i],
  // Only managers of engineers: a Product Manager or Account Manager can be any level.
  ['Senior', /\b(senior|sr\.?|staff|lead|principal|engineering manager|director|head of)\b/i],
  ['Early career', /\b(new grad|graduate|early career|junior|jr\.?|entry[- ]level|associate|engineer i|developer i|software engineer 1)\b/i],
];

export function roleFunction(title) {
  if (!title) return 'Not known';
  return FUNCTIONS.find(([, re]) => re.test(title))?.[0] ?? 'General software';
}

export function roleLevel(title) {
  if (!title) return 'Not known';
  return LEVELS.find(([, re]) => re.test(title))?.[0] ?? 'Mid-level';
}
