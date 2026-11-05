# Ace Step 1.5 Adapter

GitHub Pages의 정적 화면과 내 PC의 ComfyUI 사이를 연결하는 로컬 브리지입니다.

## 워크플로 준비

ComfyUI에서 Ace Step 1.5 워크플로를 `Save (API Format)`으로 저장하고 프로젝트 루트에 `workflow_api.json`으로 복사하세요. 이 파일은 `.gitignore`에 포함되어 공개 저장소에는 올라가지 않습니다.

## 실행

Node.js 18 이상에서 `.env.example`을 `.env`로 복사하고 `COMFYUI_URL`, `PORT`를 PC별로 설정한 뒤 `npm start`를 실행합니다. GitHub Pages 화면은 기본적으로 현재 PC의 `http://127.0.0.1:8787` 브리지를 사용합니다.

생성 이력과 오디오 보관함은 각 브라우저의 IndexedDB에 저장되며 서버에는 저장되지 않습니다. 기존 MP3/WAV는 화면의 `+ 기존 오디오 추가`로 불러올 수 있습니다.
