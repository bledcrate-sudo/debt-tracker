# Adds the Debty home-screen widget (a WidgetKit app extension) to the iOS
# project that `npx cap add ios` generates, and embeds it in the app.
# Run from the repo root after `npx cap sync ios` and before `pod install`:
#   CAP_SERVER_URL=https://… ruby ios-extras/add-widget.rb
require 'fileutils'
require 'xcodeproj'

server_url = ENV.fetch('CAP_SERVER_URL').strip.chomp('/')
project_path = 'ios/App/App.xcodeproj'
project = Xcodeproj::Project.open(project_path)

app = project.targets.find { |t| t.name == 'App' } or abort "App target not found in #{project_path}"
if project.targets.any? { |t| t.name == 'DebtyWidget' }
  puts 'DebtyWidget target already present'
  exit 0
end

# Sources next to the app's own folder: ios/App/DebtyWidget/
src = 'ios/App/DebtyWidget'
FileUtils.mkdir_p(src)
FileUtils.cp('ios-extras/DebtyWidget/DebtyWidget.swift', src)
File.write(
  File.join(src, 'Info.plist'),
  File.read('ios-extras/DebtyWidget/Info.plist').gsub('__DEBTY_SERVER_URL__', server_url)
)

app_settings = app.build_configurations.find { |c| c.name == 'Release' }&.build_settings || {}
bundle_id = app_settings['PRODUCT_BUNDLE_IDENTIFIER'] || 'com.debttracker.app'

widget = project.new_target(:app_extension, 'DebtyWidget', :ios, '17.0', nil, :swift)
group = project.main_group.new_group('DebtyWidget', 'DebtyWidget')
swift_ref = group.new_reference('DebtyWidget.swift')
group.new_reference('Info.plist')
widget.add_file_references([swift_ref])
widget.add_system_frameworks(%w[WidgetKit SwiftUI])

widget.build_configurations.each do |config|
  s = config.build_settings
  s['PRODUCT_NAME'] = '$(TARGET_NAME)'
  s['PRODUCT_BUNDLE_IDENTIFIER'] = "#{bundle_id}.DebtyWidget"
  s['INFOPLIST_FILE'] = 'DebtyWidget/Info.plist'
  s['GENERATE_INFOPLIST_FILE'] = 'NO'
  s['SWIFT_VERSION'] = '5.0'
  s['IPHONEOS_DEPLOYMENT_TARGET'] = '17.0'
  s['TARGETED_DEVICE_FAMILY'] = '1,2'
  s['SKIP_INSTALL'] = 'YES'
  s['APPLICATION_EXTENSION_API_ONLY'] = 'YES'
  s['LD_RUNPATH_SEARCH_PATHS'] = ['$(inherited)', '@executable_path/Frameworks', '@executable_path/../../Frameworks']
  s['MARKETING_VERSION'] = app_settings['MARKETING_VERSION'] || '1.0'
  s['CURRENT_PROJECT_VERSION'] = app_settings['CURRENT_PROJECT_VERSION'] || '1'
  s['CODE_SIGN_STYLE'] = 'Automatic'
  s['ENABLE_USER_SCRIPT_SANDBOXING'] = 'NO'
end

# Build the widget with the app and copy it into App.app/PlugIns.
app.add_dependency(widget)
embed = app.new_copy_files_build_phase('Embed Foundation Extensions')
embed.dst_subfolder_spec = '13' # PlugIns
embed.dst_path = ''
build_file = embed.add_file_reference(widget.product_reference, true)
build_file.settings = { 'ATTRIBUTES' => ['RemoveHeadersOnCopy'] }
# Right after Copy Bundle Resources, ahead of any script phases (an embed
# phase after scripts can trip Xcode's dependency-cycle check).
phases = app.build_phases
phases.delete(embed)
phases.insert((phases.index(app.resources_build_phase) || phases.length - 1) + 1, embed)

project.save
puts "Added DebtyWidget (#{bundle_id}.DebtyWidget), server #{server_url}"
