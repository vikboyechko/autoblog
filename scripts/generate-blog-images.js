#!/usr/bin/env node

/**
 * Blog Post Image Generator
 *
 * Generates colorful, New Yorker magazine-style illustrations for blog posts
 * using Google's Gemini image generation API.
 *
 * MODEL CONFIGURATION:
 * Currently using: gemini-3.1-flash-image-preview (PAID ~$0.067/image, pro-level quality)
 * Alternative: gemini-3-pro-image-preview (PAID ~$0.134/image, highest quality)
 * Alternative: gemini-2.0-flash-exp-image-generation (FREE experimental, lower quality)
 *
 * To switch models:
 *   1. Change MODEL_NAME below
 *   2. The generationConfig is added automatically for flash-exp models
 *   See the "MODEL SWITCH" comments throughout this file.
 *
 * IMAGE VARIETY:
 * Images alternate between light and dark color palettes for visual variety.
 * Odd-numbered images (1, 3, 5...) use light/bright backgrounds.
 * Even-numbered images (2, 4, 6...) use dark/rich backgrounds.
 *
 * Features:
 * - Automatically chunks blog content into ~300 word sections
 * - Generates one AI image per section using all example images as style references
 * - Alternates between light and dark color palettes for variety
 * - Inserts images directly into the markdown after section headings
 * - Overwrites the original markdown file with images included
 * - Saves images to src/assets/images/blog/
 *
 * Requirements:
 * - Google AI Studio API key in .env (GEMINI_API_KEY)
 * - Example images in autoblog/config/example-images/ for style reference
 * - Cost: ~$0.067/image (gemini-3.1-flash-image-preview, requires billing)
 *
 * Usage:
 *   node autoblog/scripts/generate-blog-images.js <path-to-markdown-file>
 *   node autoblog/scripts/generate-blog-images.js src/content/blog/my-post.md
 *   node autoblog/scripts/generate-blog-images.js src/content/blog/my-post.md --dry-run
 */

require("dotenv").config({ path: require("path").resolve(__dirname, "..", "..", ".env") });
const fs = require("fs");
const path = require("path");
const matter = require("gray-matter");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const https = require("https");
const sharp = require("sharp");

// Configuration
const CONFIG = {
  targetWordsPerImage: 300,
  minWordsForChunk: 150,
  maxWordsForChunk: 450,
  exampleImagesDir: path.join(__dirname, "..", "config", "example-images"),
  outputImagesDir: path.join(
    __dirname,
    "..",
    "..",
    "src",
    "assets",
    "images",
    "blog"
  ),
  numStyleReferences: "all", // Use all example images as style references
};

// Load pipeline config for site-specific image style (config.imageStyle)
const config = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "config", "pipeline.config.json"), "utf8")
);

// Initialize Gemini
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// --- MODEL SWITCH ---
// Options:
//   "gemini-3.1-flash-image-preview" - Nano Banana 2 (pro-level quality, ~$0.0672/image, requires billing)
//   "gemini-3-pro-image-preview"     - Nano Banana Pro (highest quality, ~$0.134/image, requires billing)
//   "gemini-2.0-flash-exp-image-generation" - Free experimental (lower quality, no billing needed)
const MODEL_NAME = "gemini-3.1-flash-image-preview";

/**
 * Count words in a string
 */
function countWords(text) {
  return text
    .trim()
    .split(/\s+/)
    .filter((word) => word.length > 0).length;
}

/**
 * Load example images as base64 for style reference
 */
function loadExampleImages(count = 2) {
  const exampleDir = CONFIG.exampleImagesDir;
  const files = fs
    .readdirSync(exampleDir)
    .filter((f) => /\.(jpg|jpeg|png)$/i.test(f));

  // If count is "all", use all images
  let selected = files;
  if (count !== "all") {
    // Randomly select 'count' images
    const shuffled = files.sort(() => 0.5 - Math.random());
    selected = shuffled.slice(0, Math.min(count, files.length));
  }

  return selected.map((file) => {
    const filePath = path.join(exampleDir, file);
    const data = fs.readFileSync(filePath);
    const base64 = data.toString("base64");
    const mimeType = file.toLowerCase().endsWith(".png")
      ? "image/png"
      : "image/jpeg";
    return { base64, mimeType, fileName: file };
  });
}

/**
 * Parse markdown into sections based on ## headings
 */
function parseMarkdownSections(content) {
  const lines = content.split("\n");
  const sections = [];
  let currentSection = { heading: null, content: [], startLine: 0 };

  lines.forEach((line, index) => {
    if (line.startsWith("## ")) {
      // Save previous section if it has content
      if (currentSection.content.length > 0 || currentSection.heading) {
        sections.push({
          ...currentSection,
          content: currentSection.content.join("\n"),
          wordCount: countWords(currentSection.content.join("\n")),
        });
      }
      // Start new section
      currentSection = {
        heading: line,
        content: [],
        startLine: index,
      };
    } else {
      currentSection.content.push(line);
    }
  });

  // Don't forget the last section
  if (currentSection.content.length > 0 || currentSection.heading) {
    sections.push({
      ...currentSection,
      content: currentSection.content.join("\n"),
      wordCount: countWords(currentSection.content.join("\n")),
    });
  }

  return sections;
}

/**
 * Chunk sections into ~300 word segments
 */
function chunkContent(sections) {
  const chunks = [];
  let pendingSection = null;

  for (const section of sections) {
    // If section has no heading (intro text), or is very short, combine with next
    if (
      section.wordCount < CONFIG.minWordsForChunk &&
      pendingSection === null
    ) {
      pendingSection = section;
      continue;
    }

    // Combine pending with current if exists
    let workingSection = section;
    if (pendingSection) {
      workingSection = {
        heading: pendingSection.heading || section.heading,
        content: [pendingSection.content, section.content]
          .filter(Boolean)
          .join("\n\n"),
        wordCount: pendingSection.wordCount + section.wordCount,
        startLine: pendingSection.startLine,
      };
      pendingSection = null;
    }

    // If section is within target range, add as single chunk
    if (workingSection.wordCount <= CONFIG.maxWordsForChunk) {
      chunks.push({
        heading: workingSection.heading,
        content: workingSection.content,
        wordCount: workingSection.wordCount,
        insertAfterHeading: workingSection.heading,
      });
    } else {
      // Split large sections at paragraph boundaries
      const paragraphs = workingSection.content.split(/\n\n+/);
      let currentChunk = {
        words: 0,
        paragraphs: [],
        heading: workingSection.heading,
      };

      for (const para of paragraphs) {
        const paraWords = countWords(para);

        if (
          currentChunk.words + paraWords > CONFIG.maxWordsForChunk &&
          currentChunk.paragraphs.length > 0
        ) {
          // Save current chunk and start new one
          chunks.push({
            heading: currentChunk.heading,
            content: currentChunk.paragraphs.join("\n\n"),
            wordCount: currentChunk.words,
            insertAfterHeading: currentChunk.heading,
          });
          currentChunk = { words: 0, paragraphs: [], heading: null };
        }

        currentChunk.paragraphs.push(para);
        currentChunk.words += paraWords;
      }

      // Add remaining paragraphs
      if (currentChunk.paragraphs.length > 0) {
        chunks.push({
          heading: currentChunk.heading,
          content: currentChunk.paragraphs.join("\n\n"),
          wordCount: currentChunk.words,
          insertAfterHeading: currentChunk.heading,
        });
      }
    }
  }

  // Handle any remaining pending section
  if (pendingSection) {
    chunks.push({
      heading: pendingSection.heading,
      content: pendingSection.content,
      wordCount: pendingSection.wordCount,
      insertAfterHeading: pendingSection.heading,
    });
  }

  return chunks;
}

/**
 * Extract key themes from text for image prompt
 */
function extractThemes(text, heading) {
  // Remove markdown formatting
  const cleanText = text
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1") // Remove links, keep text
    .replace(/[*_`#]/g, "") // Remove formatting
    .replace(/\n+/g, " ") // Normalize whitespace
    .trim();

  const headingText = heading ? heading.replace(/^#+\s*/, "") : "";

  return { cleanText, headingText };
}

/**
 * Generate image prompt from chunk content.
 * Uses imageIndex to alternate between light and dark color palettes
 * for visual variety across the blog post.
 *
 * @param {Object} chunk - Content chunk with heading and content
 * @param {string} blogTitle - Title of the blog post
 * @param {number} imageIndex - Zero-based index of the image (0=light, 1=dark, 2=light...)
 */
function createImagePrompt(chunk, blogTitle, imageIndex = 0) {
  const { cleanText, headingText } = extractThemes(
    chunk.content,
    chunk.heading
  );

  // Take first 300 chars of content for context
  const contentPreview = cleanText.substring(0, 300);

  // Alternate between light and dark palettes for variety
  // Even indices (0, 2, 4...) = light, Odd indices (1, 3, 5...) = dark
  const isLight = imageIndex % 2 === 0;
  const paletteInstruction = isLight
    ? "Light, bright background with warm, vibrant colors and soft tones."
    : "Dark, rich background with bold, vibrant accent colors and high contrast.";

  // Use configurable style from pipeline.config.json, fall back to default
  const baseStyle = config.imageStyle
    || "New Yorker magazine style illustration. Very colorful color palette. No text or words in the image. Abstract or conceptual representation of the topic. 16:9 aspect ratio.";

  const prompt = `Create a professional, modern illustration for a tech blog post.

Blog title: "${blogTitle}"
Section: "${headingText || "Introduction"}"
Content summary: ${contentPreview}...

Style: ${baseStyle} ${paletteInstruction}`;

  return prompt;
}

/**
 * Generate image using Gemini image generation model.
 *
 * --- MODEL SWITCH ---
 * The free experimental model (gemini-2.0-flash-exp-image-generation) requires
 * responseModalities: ["Text", "Image"] in the generationConfig.
 *
 * Paid models (gemini-3-pro-image-preview, gemini-3.1-flash-image-preview)
 * do not need generationConfig. Just change MODEL_NAME at the top of this file.
 */
async function generateImageWithGeminiFlash(prompt, styleImages) {
  try {
    // --- MODEL SWITCH ---
    // Paid model (gemini-3-pro-image-preview) does not need generationConfig.
    // If using free "gemini-2.0-flash-exp-image-generation", add:
    //   generationConfig: { responseModalities: ["Text", "Image"] }
    const modelConfig = { model: MODEL_NAME };
    if (MODEL_NAME.includes("flash-exp")) {
      modelConfig.generationConfig = { responseModalities: ["Text", "Image"] };
    }
    const model = genAI.getGenerativeModel(modelConfig);

    // Build parts array with style references and prompt
    const parts = [{ text: "Here are style reference images. Study their artistic style, color palette, and illustration technique only — do NOT reproduce, copy, or include any part of these reference images in your output:" }];

    // Add style reference images
    for (const img of styleImages) {
      parts.push({
        inlineData: {
          mimeType: img.mimeType,
          data: img.base64,
        },
      });
    }

    parts.push({
      text: `Now generate a completely original image inspired by the artistic style above. The output must be an entirely new illustration with no visual elements borrowed from the reference images:\n\n${prompt}`,
    });

    // Make the API call
    const result = await model.generateContent({
      contents: [{ parts }],
    });

    const response = await result.response;

    // Extract image from response
    if (response.candidates && response.candidates[0]) {
      const responseParts = response.candidates[0].content?.parts || [];

      for (const part of responseParts) {
        if (part.inlineData && part.inlineData.mimeType?.startsWith("image/")) {
          return {
            success: true,
            data: part.inlineData.data,
            mimeType: part.inlineData.mimeType,
          };
        }
      }
    }

    return { success: false, error: "No image in response" };
  } catch (error) {
    return {
      success: false,
      error: error.message || String(error),
    };
  }
}

/**
 * Sleep helper for rate limiting
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Generate image with automatic retry on rate limit errors
 */
async function generateImage(prompt, styleImages, retryCount = 0) {
  // Use configured Gemini model (see MODEL_NAME at top of file)
  let result = await generateImageWithGeminiFlash(prompt, styleImages);

  if (result.success) {
    return result;
  }

  // Check for rate limiting and retry
  if (
    result.error &&
    (result.error.includes("429") ||
      result.error.includes("quota") ||
      result.error.includes("rate") ||
      result.error.includes("RESOURCE_EXHAUSTED"))
  ) {
    if (retryCount < 3) {
      const waitTime = (retryCount + 1) * 15; // 15s, 30s, 45s
      console.log(
        `  ⏳ Rate limited. Waiting ${waitTime}s before retry ${
          retryCount + 1
        }/3...`
      );
      await sleep(waitTime * 1000);
      return generateImage(prompt, styleImages, retryCount + 1);
    }
    return {
      success: false,
      error: "Rate limit exceeded after 3 retries. Try again in a few minutes.",
    };
  }

  // Show actual error for debugging
  console.log(`  ⚠️  API Error: ${result.error.substring(0, 150)}...`);
  return result;
}

/**
 * Save image to disk, compressed via sharp (1000px wide JPEG, quality 85)
 */
async function saveImage(imageData, slug, index) {
  const outputDir = CONFIG.outputImagesDir;

  // Ensure output directory exists
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const fileName = `${slug}-${index + 1}.jpg`;
  const filePath = path.join(outputDir, fileName);

  const buffer = Buffer.from(imageData.data, "base64");
  await sharp(buffer)
    .resize(1000, null, { withoutEnlargement: true })
    .jpeg({ quality: 85 })
    .toFile(filePath);

  return {
    fileName,
    relativePath: `/assets/images/blog/${fileName}`,
  };
}

/**
 * Insert images into markdown content
 */
function insertImagesIntoMarkdown(
  originalContent,
  chunks,
  imagePaths,
  blogTitle
) {
  let updatedContent = originalContent;

  // Process in reverse order to preserve line positions
  const insertions = chunks
    .map((chunk, index) => ({
      chunk,
      imagePath: imagePaths[index],
      index,
    }))
    .filter((item) => item.imagePath) // Only chunks with successful images
    .reverse();

  for (const { chunk, imagePath, index } of insertions) {
    if (!chunk.insertAfterHeading) continue;

    const heading = chunk.insertAfterHeading;
    const headingIndex = updatedContent.indexOf(heading);

    if (headingIndex !== -1) {
      // Find end of heading line
      const lineEnd = updatedContent.indexOf("\n", headingIndex);
      if (lineEnd !== -1) {
        // Create alt text from heading
        const altText = heading.replace(/^#+\s*/, "").replace(/['"]/g, "");
        const imageMarkdown = `\n\n![${altText}](${imagePath.relativePath})\n`;

        // Insert after heading
        updatedContent =
          updatedContent.slice(0, lineEnd + 1) +
          imageMarkdown +
          updatedContent.slice(lineEnd + 1);
      }
    }
  }

  return updatedContent;
}

/**
 * Generate slug from file path
 */
function getSlugFromPath(filePath) {
  const baseName = path.basename(filePath, ".md");
  return baseName.toLowerCase().replace(/[^a-z0-9]+/g, "-");
}

/**
 * Main function
 */
async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.log(
      "Usage: node generate-blog-images.js <path-to-markdown> [--dry-run]"
    );
    console.log(
      "Example: node generate-blog-images.js src/content/blog/my-post.md"
    );
    process.exit(1);
  }

  const inputPath = args[0];
  const dryRun = args.includes("--dry-run");

  if (!fs.existsSync(inputPath)) {
    console.error(`Error: File not found: ${inputPath}`);
    process.exit(1);
  }

  console.log(`\n📝 Processing: ${inputPath}`);
  if (dryRun) console.log("   (Dry run mode - no API calls will be made)\n");

  // Read and parse markdown
  const fileContent = fs.readFileSync(inputPath, "utf-8");
  const { data: frontmatter, content } = matter(fileContent);
  const blogTitle = frontmatter.title || "Blog Post";
  const slug = getSlugFromPath(inputPath);

  console.log(`📌 Title: ${blogTitle}`);
  console.log(`📌 Slug: ${slug}\n`);

  // Parse sections and create chunks
  const sections = parseMarkdownSections(content);
  const chunks = chunkContent(sections);

  console.log(`📊 Found ${sections.length} sections`);
  console.log(`📊 Created ${chunks.length} chunks for image generation\n`);

  // Display chunk summary
  chunks.forEach((chunk, i) => {
    const heading = chunk.heading
      ? chunk.heading.replace(/^#+\s*/, "")
      : "(Introduction)";
    console.log(
      `   Chunk ${i + 1}: ${heading.substring(0, 40)}... (${
        chunk.wordCount
      } words)`
    );
  });
  console.log("");

  if (dryRun) {
    console.log(
      "🔍 Dry run complete. Run without --dry-run to generate images.\n"
    );
    return;
  }

  // Load style reference images
  console.log("🎨 Loading style reference images...");
  const styleImages = loadExampleImages(CONFIG.numStyleReferences);
  console.log(`   Loaded: ${styleImages.map((i) => i.fileName).join(", ")}\n`);

  // Generate images for each chunk
  const imagePaths = [];

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const heading = chunk.heading
      ? chunk.heading.replace(/^#+\s*/, "")
      : "Introduction";

    // Light/dark palette alternation: even index = light, odd = dark
    const palette = i % 2 === 0 ? "light" : "dark";
    console.log(
      `🖼️  Generating image ${i + 1}/${chunks.length} (${palette}): ${heading.substring(
        0,
        40
      )}...`
    );

    const prompt = createImagePrompt(chunk, blogTitle, i);

    const result = await generateImage(prompt, styleImages);

    if (result.success) {
      const savedImage = await saveImage(result, slug, i);
      imagePaths.push(savedImage);
      console.log(`   ✅ Saved: ${savedImage.fileName}`);
    } else {
      imagePaths.push(null);
      console.log(`   ❌ Failed: ${result.error}`);
    }

    // Rate limiting pause
    if (i < chunks.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  // Insert images into markdown
  console.log("\n📝 Updating markdown with image references...");
  const updatedContent = insertImagesIntoMarkdown(
    content,
    chunks,
    imagePaths,
    blogTitle
  );

  // Reconstruct file with frontmatter
  const updatedFile = matter.stringify(updatedContent, frontmatter);

  // Write updated file (overwrite original)
  fs.writeFileSync(inputPath, updatedFile);
  console.log(`   ✅ Updated: ${inputPath}`);

  // Summary
  const successCount = imagePaths.filter((p) => p !== null).length;
  console.log(
    `\n✨ Complete! Generated ${successCount}/${chunks.length} images.`
  );

  if (successCount > 0) {
    console.log(`   Images saved to: ${CONFIG.outputImagesDir}`);
    console.log(`   Markdown updated: ${inputPath}\n`);
  } else {
    console.log(`
No images were generated. Common causes:

   1. RATE LIMITS (most common with free model)
      The free experimental model has lower rate limits.
      Wait a few minutes and try again.
      Script will automatically retry with backoff.

   2. API KEY ISSUES
      Ensure GEMINI_API_KEY is set correctly in .env

   3. MODEL UNAVAILABLE
      The experimental model may be temporarily unavailable.
      Try again later, or switch to the paid model (see top of script).

   For more info, see the documentation at the end of this script.
`);
  }
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});

/*
 * ============================================================================
 * REQUIREMENTS & TROUBLESHOOTING
 * ============================================================================
 *
 * API KEY SETUP:
 * 1. Get an API key from https://aistudio.google.com/apikey
 * 2. Add to .env: GEMINI_API_KEY=your_key_here
 * 3. No billing required for the free experimental model
 *
 * MODEL OPTIONS:
 * ┌─────────────────────────────────────────┬──────────────┬──────────────────────┐
 * │ Model                                   │ Cost         │ Notes                │
 * ├─────────────────────────────────────────┼──────────────┼──────────────────────┤
 * │ gemini-3.1-flash-image-preview          │ ~$0.067/img  │ Current default      │
 * │ gemini-3-pro-image-preview              │ ~$0.134/img  │ Highest quality      │
 * │ gemini-2.0-flash-exp-image-generation   │ FREE         │ Lower quality        │
 * └─────────────────────────────────────────┴──────────────┴──────────────────────┘
 *
 * TO SWITCH MODELS:
 * 1. Change MODEL_NAME constant near the top of this file
 * 2. For free model: generationConfig is added automatically (flash-exp detection)
 * 3. For paid models: enable billing at https://aistudio.google.com/billing
 *
 * LIGHT/DARK VARIETY:
 * Images alternate between light and dark color palettes:
 *   - Image 1 (index 0): Light background
 *   - Image 2 (index 1): Dark background
 *   - Image 3 (index 2): Light background
 *   - ...and so on
 * This is controlled in createImagePrompt() via the imageIndex parameter.
 *
 * RATE LIMITS:
 * - Free model has lower rate limits than paid
 * - Script includes 1-second delay between image generations
 * - Automatic retry with exponential backoff if rate limits hit
 * - If persistent rate limiting, wait a few minutes or switch to paid model
 *
 * EXAMPLE IMAGES:
 * - Place style reference images in ../config/example-images/
 * - JPG or PNG format, any resolution
 * - ALL images in folder will be used as style references
 * - Current setup uses 5 example images to guide style consistency
 *
 * USAGE:
 *   node scripts/generate-blog-images.js <markdown-file> [--dry-run]
 *
 * EXAMPLES:
 *   # Preview chunks without generating images
 *   node scripts/generate-blog-images.js src/content/blog/my-post.md --dry-run
 *
 *   # Generate images and update markdown
 *   node scripts/generate-blog-images.js src/content/blog/my-post.md
 *
 * OUTPUT:
 *   - Images: src/assets/images/blog/<slug>-1.jpg, <slug>-2.jpg, ... (1000px wide, JPEG q85)
 *   - Markdown: Original file is updated in-place with image references
 *
 * CUSTOMIZATION:
 *   - Image style: Edit createImagePrompt() function (New Yorker magazine style)
 *   - Light/dark: Edit the palette alternation in createImagePrompt()
 *   - Chunk size: Adjust CONFIG.targetWordsPerImage (default: 300 words)
 *   - Model: Change MODEL_NAME constant (see "MODEL SWITCH" comments)
 *
 * ============================================================================
 */
