/**
 * test-student.mjs — Quick smoke test of the layaStudentModel
 */
import { studentSystemOne, compareDistilled } from "../src/lib/layaStudentModel.js";

const testCases = [
  {
    name: "Transport: 點去旺角 (Cantonese, MTR)",
    state: {
      query: "點去旺角?",
      userLocation: { lat: 22.2819, lng: 114.1459 },
      destination: { name: "Mong Kok" },
      userPreferences: { mobilityNeeds: false, budget: "moderate" },
      locale: "zh-Hant",
    },
    questions: {
      transport: {
        type: "choice",
        criteria: { mtr: "MTR", bus: "Bus", taxi: "Taxi", walk: "Walk", ferry: "Ferry" },
      },
    },
    expected: "mtr",
  },
  {
    name: "Transport: How do I get to Victoria Peak from Central?",
    state: {
      query: "How do I get to Victoria Peak from Central?",
      userLocation: { lat: 22.2819, lng: 114.1459 },
      destination: { name: "Victoria Peak" },
    },
    questions: {
      transport: {
        type: "choice",
        criteria: { mtr: "MTR", bus: "Bus", taxi: "Taxi", walk: "Walk", ferry: "Ferry" },
      },
    },
    expected: null, // ambiguous
  },
  {
    name: "App function: 旺角有咩好食?",
    state: { query: "旺角有咩好食?" },
    questions: {
      function: {
        type: "choice",
        criteria: { toilets: "T", transport: "T", planner: "P", search: "S", home: "H" },
      },
    },
    expected: "search",
  },
  {
    name: "App function: nearest toilet",
    state: { query: "nearest public toilet" },
    questions: {
      function: {
        type: "choice",
        criteria: { toilets: "T", transport: "T", planner: "P", search: "S", home: "H" },
      },
    },
    expected: "toilets",
  },
  {
    name: "Ticket: broken glass near bus stop",
    state: {
      subject: "Broken glass near bus stop",
      body: "There's broken glass all over the ground near the bus stop at Nathan Road.",
    },
    questions: {
      category: {
        type: "choice",
        criteria: { data: "D", infra: "I", ux: "U", content: "C", safety: "S" },
      },
    },
    expected: "safety",
  },
];

let passed = 0;
let total = testCases.length;
for (const tc of testCases) {
  const result = studentSystemOne(tc.state, tc.questions);
  const qkey = Object.keys(result.answers)[0];
  const answer = result.answers[qkey];
  const choice = answer.choice ?? `level ${Math.round(answer.expected ?? 0)}`;
  const conf = answer.confidence ?? answer.noul ?? 0;
  const ok = tc.expected ? choice === tc.expected : "✓";
  if (choice === tc.expected) passed++;
  const mark = ok === "✓" || ok === true ? "✅" : "❌";
  console.log(`\n${mark} ${tc.name}`);
  console.log(`   Picked:  ${choice} (expected: ${tc.expected ?? "any"})`);
  console.log(`   Conf:    ${(conf * 100).toFixed(1)}%`);
  console.log(`   Stats:   ${JSON.stringify(result.studentStats)}`);
}

console.log(`\n\nResult: ${passed}/${total} tests passed`);
