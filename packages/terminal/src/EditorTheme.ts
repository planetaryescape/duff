import { reviewPalettes } from './ReviewTheme'

export const editorThemeLua = String.raw`
local function review_highlights()
  local light = vim.o.background == "light"
  local normal = vim.api.nvim_get_hl(0, { name = "Normal", link = false })
  local palette = light and {
    background = "${reviewPalettes.light.background}",
    added = "${reviewPalettes.light.status.A}",
    changed = "${reviewPalettes.light.status.M}",
    deleted = "${reviewPalettes.light.status.D}",
  } or {
    background = "${reviewPalettes.dark.background}",
    added = "${reviewPalettes.dark.status.A}",
    changed = "${reviewPalettes.dark.status.M}",
    deleted = "${reviewPalettes.dark.status.D}",
  }
  local background = normal.bg or tonumber(palette.background:sub(2), 16)
  local function tint(color)
    local foreground = tonumber(color:sub(2), 16)
    local result = 0
    for _, shift in ipairs({ 16, 8, 0 }) do
      local base = bit.band(bit.rshift(background, shift), 255)
      local accent = bit.band(bit.rshift(foreground, shift), 255)
      local channel = math.floor(base * 0.92 + accent * 0.08 + 0.5)
      result = result + bit.lshift(channel, shift)
    end
    return result
  end
  vim.api.nvim_set_hl(0, "DuffAddedLine", { bg = tint(palette.added) })
  vim.api.nvim_set_hl(0, "DuffDeletedLine", { bg = tint(palette.deleted) })
  vim.api.nvim_set_hl(0, "DuffRemovedText", { fg = normal.fg, bg = tint(palette.deleted) })
  vim.api.nvim_set_hl(0, "DuffAddedSign", { fg = palette.added })
  vim.api.nvim_set_hl(0, "DuffChangedSign", { fg = palette.changed })
  vim.api.nvim_set_hl(0, "DuffDeletedSign", { fg = palette.deleted })
end
`
