{ pkgs }: {
  deps = [
    pkgs.nodejs_22
    # Renders .pptx/.docx/.xlsx to PDF once per file hash so Gemini sees the
    # actual slides. Without it the app falls back to the OOXML manifest +
    # text digest (no visual grading).
    pkgs.libreoffice-fresh
    # Fonts LibreOffice needs to render decks faithfully.
    pkgs.dejavu_fonts
    pkgs.liberation_ttf
    pkgs.noto-fonts
    pkgs.noto-fonts-cjk-sans
    pkgs.noto-fonts-emoji
    pkgs.fontconfig
  ];
}
