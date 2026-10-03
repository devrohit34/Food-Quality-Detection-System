# 🍎 Food Quality Detection System

An AI-powered Food Quality Detection System designed to analyze food images and provide an intelligent assessment of food quality.

The system uses image-based analysis to detect visible quality characteristics and present the results through a simple and user-friendly interface.

---
## 🌐 Live Demo

👉 [**FoodVision AI – Live Website**](https://food-quality-detection-system.vercel.app/)


## 🚀 Features

- 📸 Food image upload
- 🔍 AI-based food quality analysis
- 📊 Quality assessment and result visualization
- 🖼️ Image preview
- ⚡ Fast analysis workflow
- 📱 Responsive user interface
- 🎨 Clean and modern dashboard
- 🔄 Real-time result display
- 🧠 Intelligent image-based detection

---

## 🛠️ Technology Stack

### Frontend

- React
- TypeScript
- Vite
- Tailwind CSS

### AI / Detection

- Image Processing
- Machine Learning / AI-based Analysis

### Development Tools

- Node.js
- npm
- Git
- GitHub

## OpenAI vision configuration

Food image analysis runs on the server with OpenAI's `gpt-4o-mini` vision model. Set
`OPENAI_API_KEY` in a local `.env` file (copy `.env.example`) or as a server deployment
environment variable. Never use a `VITE_` prefix for this secret. Restart the dev server
after changing `.env`; the API key is not sent to the browser. For Cloudflare Workers,
configure it as a Worker secret (for example, `npx wrangler secret put OPENAI_API_KEY`).

---

## 📁 Project Structure

```text
Food_Quality_Detection_System/
│
├── public/
│
├── src/
│   ├── assets/
│   ├── components/
│   ├── hooks/
│   ├── lib/
│   ├── routes/
│   ├── test/
│   ├── router.tsx
│   ├── routeTree.gen.ts
│   ├── styles.css
│   └── main.tsx
│
├── package.json
├── tsconfig.json
├── vite.config.ts
├── components.json
└── README.md
```
