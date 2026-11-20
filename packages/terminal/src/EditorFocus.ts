export const focusLua = String.raw`
local focus_windows = {}
local fold_namespace = vim.api.nvim_create_namespace("duff.folds")
local fold_options = { "foldmethod", "foldexpr", "foldtext", "foldenable", "foldlevel", "foldminlines", "foldnestmax" }

local function fold_command(line, command)
  vim.api.nvim_win_set_cursor(0, { line, 0 })
  vim.cmd("normal! " .. command)
end

local function save_folds(buffer)
  local saved = { buffer = buffer, options = {}, ranges = {}, closed = {} }
  for _, name in ipairs(fold_options) do saved.options[name] = vim.wo[name] end
  local view = vim.fn.winsaveview()
  vim.wo.foldenable = true
  local count = vim.api.nvim_buf_line_count(buffer)
  local line = 1
  while line <= count do
    local first = vim.fn.foldclosed(line)
    if first >= 0 then
      local last = vim.fn.foldclosedend(line)
      saved.closed[first .. ":" .. last] = true
      fold_command(first, "zo")
    else
      line = line + 1
    end
  end
  vim.cmd("normal! zM")
  local function visit(first, last)
    local row = first
    while row <= last do
      local start = vim.fn.foldclosed(row)
      if start >= 0 then
        local finish = vim.fn.foldclosedend(row)
        local id = vim.api.nvim_buf_set_extmark(buffer, fold_namespace, start - 1, 0, {
          end_row = finish, end_col = 0, right_gravity = false, end_right_gravity = true,
        })
        table.insert(saved.ranges, { id = id, closed = saved.closed[start .. ":" .. finish] == true })
        fold_command(start, "zo")
        visit(start, finish)
        row = finish + 1
      else
        row = row + 1
      end
    end
  end
  visit(1, count)
  vim.fn.winrestview(view)
  return saved
end

local function restore_focus(window)
  local saved = focus_windows[window]
  if not saved then return end
  focus_windows[window] = nil
  if vim.api.nvim_win_is_valid(window) and vim.api.nvim_win_get_buf(window) == saved.buffer then
    vim.api.nvim_win_call(window, function()
      local view = vim.fn.winsaveview()
      vim.wo.foldmethod = "manual"
      vim.cmd("normal! zE")
      local ranges = {}
      for _, range in ipairs(saved.ranges) do
        local mark = vim.api.nvim_buf_get_extmark_by_id(saved.buffer, fold_namespace, range.id, { details = true })
        if #mark > 0 then
          table.insert(ranges, { first = mark[1] + 1, last = mark[3].end_row, closed = range.closed })
        end
      end
      if saved.options.foldmethod == "manual" then
        for index = #ranges, 1, -1 do
          local range = ranges[index]
          if range.last > range.first then vim.cmd(range.first .. "," .. range.last .. "fold") end
        end
      end
      for _, name in ipairs(fold_options) do vim.wo[name] = saved.options[name] end
      vim.wo.foldenable = true
      for _, range in ipairs(ranges) do
        if vim.fn.foldlevel(range.first) > 0 then fold_command(range.first, "zO") end
      end
      for index = #ranges, 1, -1 do
        local range = ranges[index]
        if range.closed and vim.fn.foldlevel(range.first) > 0 then fold_command(range.first, "zc") end
      end
      vim.wo.foldenable = saved.options.foldenable
      vim.fn.winrestview(view)
    end)
  end
  if vim.api.nvim_buf_is_valid(saved.buffer) then
    for _, range in ipairs(saved.ranges) do vim.api.nvim_buf_del_extmark(saved.buffer, fold_namespace, range.id) end
  end
end

local function apply_focus(buffer, changes, context, enabled)
  for _, window in ipairs(vim.fn.win_findbuf(buffer)) do
    if not enabled then
      restore_focus(window)
    else
      vim.api.nvim_win_call(window, function()
        if not focus_windows[window] then focus_windows[window] = save_folds(buffer) end
        local view = vim.fn.winsaveview()
        local count = vim.api.nvim_buf_line_count(buffer)
        local visible = {}
        for _, change in ipairs(changes) do
          local start = math.max(1, change[3] - context)
          local finish = math.min(count, change[3] + math.max(change[4], 1) - 1 + context)
          for line = start, finish do visible[line] = true end
        end
        vim.wo.foldmethod = "manual"
        vim.wo.foldtext = "'... ' . (v:foldend - v:foldstart + 1) . ' unchanged lines'"
        vim.wo.foldminlines = 0
        vim.wo.foldenable = true
        vim.cmd("normal! zE")
        local start
        for line = 1, count + 1 do
          if line <= count and not visible[line] then
            start = start or line
          elseif start then
            if line - start > 1 then vim.cmd(start .. "," .. (line - 1) .. "fold") end
            start = nil
          end
        end
        vim.wo.foldlevel = 0
        vim.fn.winrestview(view)
      end)
    end
  end
end
`
