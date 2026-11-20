import { focusLua } from './EditorFocus'

export const editorLua = String.raw`
local channel = ...
local namespace = vim.api.nvim_create_namespace("duff.review")
local bases = {}
local hunks = {}
local focus_mode = false
local show_removed = true
local focus_context = 3

${focusLua}

local function text(buffer)
  local lines = vim.api.nvim_buf_get_lines(buffer, 0, -1, false)
  local value = table.concat(lines, "\n")
  if vim.bo[buffer].endofline then value = value .. "\n" end
  return value
end

local function refresh(buffer)
  local review = bases[buffer]
  if not review or not vim.api.nvim_buf_is_valid(buffer) then return end
  vim.api.nvim_buf_clear_namespace(buffer, namespace, 0, -1)
  local current = text(buffer)
  local changes = vim.diff(review.base, current, { result_type = "indices", algorithm = "histogram" })
  local previous = vim.split(review.base, "\n", { plain = true })
  hunks[buffer] = {}
  local count = vim.api.nvim_buf_line_count(buffer)
  for _, change in ipairs(changes) do
    local old_start, old_count, new_start, new_count = unpack(change)
    local row = math.min(math.max(new_start - 1, 0), count - 1)
    if new_count == 0 then row = math.min(math.max(new_start, 0), count - 1) end
    table.insert(hunks[buffer], { line = row + 1, removed = old_count })
    for offset = 0, new_count - 1 do
      local line = new_start - 1 + offset
      if line < count then
        vim.api.nvim_buf_set_extmark(buffer, namespace, line, 0, {
          line_hl_group = "DiffAdd", sign_text = "+", sign_hl_group = "DiffAdd",
          priority = 90,
        })
      end
    end
    if old_count > 0 then
      local removed = {}
      for offset = 0, old_count - 1 do
        table.insert(removed, { { "- " .. (previous[old_start + offset] or ""), "DiffDelete" } })
      end
      local anchor = row
      local above = true
      if new_count == 0 then
        anchor = math.min(new_start, count - 1)
        above = new_start < count
      end
      vim.api.nvim_buf_set_extmark(buffer, namespace, anchor, 0, {
        virt_lines = show_removed and removed or {}, virt_lines_above = above,
        sign_text = new_count > 0 and "~" or "_",
        sign_hl_group = new_count > 0 and "DiffChange" or "DiffDelete", priority = 100,
      })
    end
  end
  vim.b[buffer].duff_review = true
  apply_focus(buffer, changes, focus_context, focus_mode)
end

_G.DuffReview = {}

local function show_hunk(buffer, hunk)
  vim.api.nvim_win_set_cursor(0, { hunk.line, 0 })
  vim.cmd("normal! zvzz")
  if show_removed and hunk.line == 1 and hunk.removed > 0 then
    vim.fn.winrestview({ topline = 1, topfill = hunk.removed })
  end
end

function DuffReview.reset()
  for window, _ in pairs(focus_windows) do restore_focus(window) end
  for buffer, _ in pairs(bases) do
    if vim.api.nvim_buf_is_valid(buffer) then
      vim.api.nvim_buf_clear_namespace(buffer, namespace, 0, -1)
      vim.b[buffer].duff_review = false
    end
  end
  bases = {}
  hunks = {}
end

function DuffReview.display(focus, removed, context)
  focus_mode = focus
  show_removed = removed
  focus_context = context
  for buffer, review in pairs(bases) do
    if not review.readonly then refresh(buffer) end
  end
  vim.cmd("redraw!")
end

function DuffReview.open(path, base, readonly)
  local buffer
  if readonly then
    local name = "duff://deleted/" .. path
    buffer = vim.fn.bufnr(name)
    if buffer == -1 then
      buffer = vim.api.nvim_create_buf(false, true)
      vim.api.nvim_buf_set_name(buffer, name)
      vim.bo[buffer].filetype = vim.filetype.match({ filename = path }) or ""
    end
    local lines = vim.split(base, "\n", { plain = true })
    if lines[#lines] == "" then table.remove(lines) end
    vim.bo[buffer].modifiable = true
    vim.api.nvim_buf_set_lines(buffer, 0, -1, false, lines)
    vim.bo[buffer].modifiable = false
    vim.bo[buffer].readonly = true
    vim.api.nvim_buf_clear_namespace(buffer, namespace, 0, -1)
    for row = 0, vim.api.nvim_buf_line_count(buffer) - 1 do
      vim.api.nvim_buf_set_extmark(buffer, namespace, row, 0, {
        line_hl_group = "DiffDelete", sign_text = "-", sign_hl_group = "DiffDelete",
      })
    end
  else
    buffer = vim.fn.bufadd(path)
    vim.fn.bufload(buffer)
  end
  bases[buffer] = { base = base, readonly = readonly }
  vim.api.nvim_set_current_buf(buffer)
  if not readonly then
    refresh(buffer)
    local first = (hunks[buffer] or {})[1]
    if first then show_hunk(buffer, first) end
  else
    hunks[buffer] = { { line = 1, removed = 0 } }
    vim.api.nvim_win_set_cursor(0, { 1, 0 })
  end
  return vim.fn.sha256(text(buffer))
end

function DuffReview.fingerprint()
  local buffer = vim.api.nvim_get_current_buf()
  return { path = vim.api.nvim_buf_get_name(buffer), hash = vim.fn.sha256(text(buffer)) }
end

function DuffReview.hunk(direction, edge)
  local buffer = vim.api.nvim_get_current_buf()
  local line = vim.api.nvim_win_get_cursor(0)[1]
  local positions = hunks[buffer] or {}
  local result = {
    path = vim.api.nvim_buf_get_name(buffer),
    moved = false,
    reviewed = bases[buffer] ~= nil,
  }
  if direction < 0 then positions = vim.fn.reverse(vim.deepcopy(positions)) end
  if edge and positions[1] then
    show_hunk(buffer, positions[1])
    result.moved = true
    return result
  end
  for _, target in ipairs(positions) do
    if (direction > 0 and target.line > line) or (direction < 0 and target.line < line) then
      show_hunk(buffer, target)
      result.moved = true
      return result
    end
  end
  return result
end

local group = vim.api.nvim_create_augroup("DuffReview", { clear = true })
local function report_background()
  vim.rpcnotify(channel, "duff.theme", vim.o.background)
end
vim.api.nvim_create_autocmd("OptionSet", {
  group = group, pattern = "background", callback = report_background,
})
vim.api.nvim_create_autocmd("ColorScheme", {
  group = group, callback = report_background,
})
report_background()
vim.api.nvim_create_autocmd({ "TextChanged", "TextChangedI", "BufWritePost" }, {
  group = group,
  callback = function(event)
    refresh(event.buf)
    if event.event == "BufWritePost" then
      vim.rpcnotify(channel, "duff.saved", vim.api.nvim_buf_get_name(event.buf), vim.fn.sha256(text(event.buf)))
    end
  end,
})
vim.api.nvim_create_autocmd("BufWipeout", {
  group = group,
  callback = function(event) bases[event.buf] = nil; hunks[event.buf] = nil end,
})
vim.api.nvim_create_autocmd("BufEnter", {
  group = group,
  callback = function(event)
    vim.rpcnotify(channel, "duff.active", vim.api.nvim_buf_get_name(event.buf))
  end,
})
vim.api.nvim_create_autocmd("BufWinLeave", {
  group = group,
  callback = function(event)
    local window = vim.api.nvim_get_current_win()
    if focus_windows[window] and focus_windows[window].buffer == event.buf then restore_focus(window) end
  end,
})
vim.api.nvim_create_autocmd("BufWinEnter", {
  group = group,
  callback = function(event)
    local review = bases[event.buf]
    if review and not review.readonly then refresh(event.buf) end
  end,
})
vim.api.nvim_create_autocmd("WinClosed", {
  group = group,
  callback = function(event) restore_focus(tonumber(event.match)) end,
})
vim.api.nvim_create_user_command("DuffFiles", function() vim.rpcnotify(channel, "duff.files") end, {})
vim.api.nvim_create_user_command("DuffViewed", function() vim.rpcnotify(channel, "duff.viewed") end, {})
vim.api.nvim_create_user_command("DuffNextHunk", function() vim.rpcnotify(channel, "duff.hunk", 1) end, {})
vim.api.nvim_create_user_command("DuffPreviousHunk", function() vim.rpcnotify(channel, "duff.hunk", -1) end, {})
vim.api.nvim_create_user_command("DuffToggleView", function() vim.rpcnotify(channel, "duff.toggle-view") end, {})
vim.api.nvim_create_user_command("DuffViewedNext", function() vim.rpcnotify(channel, "duff.viewed-next") end, {})
vim.api.nvim_create_user_command("DuffFocus", function() vim.rpcnotify(channel, "duff.focus-mode") end, {})
vim.api.nvim_create_user_command("DuffRemoved", function() vim.rpcnotify(channel, "duff.removed-lines") end, {})
vim.api.nvim_create_user_command("DuffHelp", function() vim.rpcnotify(channel, "duff.help") end, {})
`
