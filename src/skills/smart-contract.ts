/**
 * Smart Contract Skill — Multi-chain Dev & Security
 *
 * EVM/Solidity + Solana/Rust+Anchor
 * Primarily Claude-powered analysis — no external API keys needed.
 * On-chain verification via Etherscan/Solscan when keys available.
 */

import type Anthropic from "@anthropic-ai/sdk";

export const definitions: Anthropic.Tool[] = [
  {
    name: "analyze_contract",
    description:
      "Analyze a smart contract's code. Provide the source code and get a breakdown of its functionality, state variables, access control, and key mechanisms. Supports Solidity (EVM) and Rust/Anchor (Solana).",
    input_schema: {
      type: "object" as const,
      properties: {
        code: { type: "string", description: "The smart contract source code" },
        language: {
          type: "string",
          description: "Contract language: 'solidity' or 'rust' (auto-detected if omitted)",
        },
      },
      required: ["code"],
    },
  },
  {
    name: "generate_contract",
    description:
      "Generate a smart contract from a natural language specification. Specify the chain and requirements.",
    input_schema: {
      type: "object" as const,
      properties: {
        spec: {
          type: "string",
          description: "Natural language description of what the contract should do",
        },
        chain: {
          type: "string",
          description: "Target chain: 'evm' (Solidity) or 'solana' (Rust/Anchor). Default: evm",
        },
        features: {
          type: "array",
          items: { type: "string" },
          description: "Required features: e.g., ['ownable', 'pausable', 'upgradeable', 'erc20', 'erc721']",
        },
      },
      required: ["spec"],
    },
  },
  {
    name: "audit_security",
    description:
      "Perform a security audit on smart contract code. Checks for common vulnerabilities like reentrancy, integer overflow, access control issues, front-running, and more.",
    input_schema: {
      type: "object" as const,
      properties: {
        code: { type: "string", description: "The smart contract source code to audit" },
        language: { type: "string", description: "Contract language: 'solidity' or 'rust'" },
      },
      required: ["code"],
    },
  },
  {
    name: "explain_vulnerability",
    description:
      "Explain a specific smart contract vulnerability in detail with examples and mitigation strategies.",
    input_schema: {
      type: "object" as const,
      properties: {
        vulnerability: {
          type: "string",
          description: "Vulnerability name: reentrancy, overflow, access-control, front-running, flash-loan, oracle-manipulation, delegatecall, tx-origin, account-validation, pda-collision",
        },
        chain: { type: "string", description: "Chain context: 'evm' or 'solana'" },
      },
      required: ["vulnerability"],
    },
  },
  {
    name: "get_verified_source",
    description:
      "Fetch verified source code of a deployed contract from Etherscan or Solscan.",
    input_schema: {
      type: "object" as const,
      properties: {
        address: { type: "string", description: "Contract address" },
        chain: {
          type: "string",
          description: "Chain: ethereum, base, arbitrum, polygon, solana",
        },
      },
      required: ["address", "chain"],
    },
  },
];

export async function handler(toolName: string, input: Record<string, unknown>): Promise<string> {
  switch (toolName) {
    case "analyze_contract":
      return analyzeContract(input);
    case "generate_contract":
      return generateContract(input);
    case "audit_security":
      return auditSecurity(input);
    case "explain_vulnerability":
      return explainVulnerability(input);
    case "get_verified_source":
      return getVerifiedSource(input);
    default:
      return `Unknown smart contract tool: ${toolName}`;
  }
}

function analyzeContract(input: Record<string, unknown>): string {
  const code = input.code as string;
  const lang = detectLanguage(code, input.language as string);

  // Return the code with analysis instructions — Claude will do the actual analysis
  return JSON.stringify({
    instruction: "Analyze this smart contract and provide a breakdown",
    language: lang,
    code_length: code.length,
    code_preview: code.substring(0, 2000),
    analysis_points: [
      "Contract purpose and functionality",
      "State variables and data structures",
      "Access control mechanisms",
      "Key functions and their roles",
      "External calls and dependencies",
      "Events emitted",
      lang === "solidity" ? "Gas optimization opportunities" : "Compute unit considerations",
    ],
  });
}

function generateContract(input: Record<string, unknown>): string {
  const spec = input.spec as string;
  const chain = ((input.chain as string) || "evm").toLowerCase();
  const features = (input.features as string[]) || [];

  return JSON.stringify({
    instruction: "Generate a smart contract based on this specification",
    specification: spec,
    target: chain === "solana" ? "Rust with Anchor framework" : "Solidity ^0.8.20",
    features,
    guidelines:
      chain === "solana"
        ? [
            "Use Anchor framework with proper account validation",
            "Include PDA derivation where needed",
            "Add proper error handling with custom errors",
            "Include instruction discriminators",
          ]
        : [
            "Use OpenZeppelin contracts where applicable",
            "Follow checks-effects-interactions pattern",
            "Use custom errors instead of require strings",
            "Include NatSpec documentation",
            "Consider gas optimization",
          ],
  });
}

function auditSecurity(input: Record<string, unknown>): string {
  const code = input.code as string;
  const lang = detectLanguage(code, input.language as string);

  const checklist =
    lang === "solidity"
      ? [
          "Reentrancy (external calls before state updates)",
          "Integer overflow/underflow (pre-0.8.0 or unchecked blocks)",
          "Access control (missing onlyOwner, role checks)",
          "Front-running / MEV vulnerability",
          "Flash loan attack vectors",
          "Oracle manipulation risks",
          "Delegatecall to untrusted contracts",
          "tx.origin authentication",
          "Unchecked return values",
          "DoS via block gas limit",
          "Timestamp dependence",
          "Centralization risks (admin keys)",
        ]
      : [
          "Missing account validation / constraint checks",
          "PDA seed collision",
          "Missing signer checks",
          "CPI (Cross-Program Invocation) risks",
          "Account data not properly validated",
          "Missing ownership checks",
          "Arithmetic overflow in non-checked math",
          "Account reinitialization",
          "Closing accounts without draining lamports",
          "Type cosplay (account type confusion)",
        ];

  return JSON.stringify({
    instruction: "Perform a security audit on this smart contract",
    language: lang,
    code_length: code.length,
    code_preview: code.substring(0, 3000),
    checklist,
    severity_levels: ["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFORMATIONAL"],
    output_format: "For each finding: severity, title, location, description, recommendation",
  });
}

function explainVulnerability(input: Record<string, unknown>): string {
  const vuln = input.vulnerability as string;
  const chain = ((input.chain as string) || "evm").toLowerCase();

  return JSON.stringify({
    instruction: "Explain this smart contract vulnerability in detail",
    vulnerability: vuln,
    chain,
    include: [
      "What it is and why it's dangerous",
      "How the attack works (step by step)",
      "Real-world examples if known",
      "Code example showing the vulnerability",
      "How to fix / mitigate",
      "Testing strategies to detect it",
    ],
  });
}

async function getVerifiedSource(input: Record<string, unknown>): Promise<string> {
  const address = input.address as string;
  const chain = ((input.chain as string) || "ethereum").toLowerCase();

  if (chain === "solana") {
    const apiKey = process.env.SOLSCAN_API_KEY;
    if (!apiKey) return "SOLSCAN_API_KEY not set. Cannot fetch Solana program source.";

    const response = await fetch(
      `https://pro-api.solscan.io/v2.0/account/${address}`,
      { headers: { token: apiKey } }
    );
    if (!response.ok) return `Solscan API error: ${response.status}`;
    const data = await response.json();
    return JSON.stringify(data.data || data, null, 2).substring(0, 3000);
  }

  // EVM chains
  const explorerUrls: Record<string, string> = {
    ethereum: "https://api.etherscan.io/api",
    base: "https://api.basescan.org/api",
    arbitrum: "https://api.arbiscan.io/api",
    polygon: "https://api.polygonscan.com/api",
  };

  const url = explorerUrls[chain];
  if (!url) return `Unsupported chain: ${chain}`;

  const apiKey = process.env.ETHERSCAN_API_KEY || "";
  const params = new URLSearchParams({
    module: "contract",
    action: "getsourcecode",
    address,
    ...(apiKey ? { apikey: apiKey } : {}),
  });

  const response = await fetch(`${url}?${params}`);
  if (!response.ok) return `Explorer API error: ${response.status}`;

  const data = await response.json();
  if (data.status !== "1" || !data.result?.[0]) {
    return `Contract not verified or not found at ${address} on ${chain}.`;
  }

  const contract = data.result[0];
  const source = contract.SourceCode || "";

  return [
    `Contract: ${contract.ContractName}`,
    `Compiler: ${contract.CompilerVersion}`,
    `Optimization: ${contract.OptimizationUsed === "1" ? "Yes" : "No"}`,
    `License: ${contract.LicenseType || "N/A"}`,
    `\nSource Code (first 3000 chars):\n${source.substring(0, 3000)}`,
  ].join("\n");
}

function detectLanguage(code: string, hint?: string): string {
  if (hint) return hint.toLowerCase();
  if (code.includes("pragma solidity") || code.includes("contract ") || code.includes("function ")) {
    return "solidity";
  }
  if (code.includes("#[program]") || code.includes("use anchor_lang") || code.includes("pub fn")) {
    return "rust";
  }
  return "solidity"; // default
}
