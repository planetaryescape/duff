export const editorLua = String.raw`
local channel = ...
local namespace = vim.api.nvim_create_namespace("duff.review")
local bases = {}
local hunks = {}

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
    table.insert(hunks[buffer], row + 1)
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
        virt_lines = removed, virt_lines_above = above,
        sign_text = new_count > 0 and "~" or "_",
        sign_hl_group = new_count > 0 and "DiffChange" or "DiffDelete", priority = 100,
      })
    end
  end
  vim.b[buffer].duff_review = true
end

_G.DuffReview = {}

function DuffReview.reset()
  for buffer, _ in pairs(bases) do
    if vim.api.nvim_buf_is_valid(buffer) then
      vim.api.nvim_buf_clear_namespace(buffer, namespace, 0, -1)
      vim.b[buffer].duff_review = false
    end
  end
  bases = {}
  hunks = {}
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
    local first = vim.diff(base, text(buffer), { result_type = "indices" })[1]
    if first and first[1] == 1 and first[2] > 0 then
      vim.fn.winrestview({ topline = 1, topfill = first[2] })
    end
  end
  return vim.fn.sha256(text(buffer))
end

function DuffReview.fingerprint()
  local buffer = vim.api.nvim_get_current_buf()
  return { path = vim.api.nvim_buf_get_name(buffer), hash = vim.fn.sha256(text(buffer)) }
end

function DuffReview.hunk(direction)
  local buffer = vim.api.nvim_get_current_buf()
  local line = vim.api.nvim_win_get_cursor(0)[1]
  local positions = hunks[buffer] or {}
  if direction < 0 then positions = vim.fn.reverse(vim.deepcopy(positions)) end
  for _, target in ipairs(positions) do
    if (direction > 0 and target > line) or (direction < 0 and target < line) then
      vim.api.nvim_win_set_cursor(0, { target, 0 })
      return
    end
  end
end

local group = vim.api.nvim_create_augroup("DuffReview", { clear = true })
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
vim.api.nvim_create_user_command("DuffFiles", function() vim.rpcnotify(channel, "duff.files") end, {})
vim.api.nvim_create_user_command("DuffViewed", function() vim.rpcnotify(channel, "duff.viewed") end, {})
vim.api.nvim_create_user_command("DuffNextHunk", function() DuffReview.hunk(1) end, {})
vim.api.nvim_create_user_command("DuffPreviousHunk", function() DuffReview.hunk(-1) end, {})
`
